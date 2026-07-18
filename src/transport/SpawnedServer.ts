import { spawn, type ChildProcessByStdio } from 'child_process'
import { EventEmitter } from 'events'
import type { Readable } from 'stream'

import { parseListenLine } from './listenLine.js'

export type SpawnedServerOptions = {
  binary?: string
  cwd: string
  hostname?: string
  port?: number
  env?: NodeJS.ProcessEnv
  configContent?: string
  password?: string
  pure?: boolean
  startupTimeoutMs?: number
  disposeOnStop?: boolean
}

export type SpawnedServerInfo = {
  url: string
  child: OpenCodeServerProcess
}

type OpenCodeServerProcess = ChildProcessByStdio<null, Readable, Readable>

export type SpawnedServerEvents = {
  stdout: [string]
  stderr: [string]
  exit: [{ exitCode: number | null; signal: NodeJS.Signals | null }]
}

export interface SpawnedServer {
  on<K extends keyof SpawnedServerEvents>(
    event: K,
    listener: (...args: SpawnedServerEvents[K]) => void,
  ): this
  off<K extends keyof SpawnedServerEvents>(
    event: K,
    listener: (...args: SpawnedServerEvents[K]) => void,
  ): this
  emit<K extends keyof SpawnedServerEvents>(
    event: K,
    ...args: SpawnedServerEvents[K]
  ): boolean
}

export class SpawnedServer extends EventEmitter {
  private readonly opts: Required<
    Pick<SpawnedServerOptions, 'binary' | 'hostname' | 'startupTimeoutMs' | 'disposeOnStop'>
  > &
    Omit<SpawnedServerOptions, 'binary' | 'hostname' | 'startupTimeoutMs' | 'disposeOnStop'>
  private child: OpenCodeServerProcess | null = null
  private url: string | null = null

  constructor(opts: SpawnedServerOptions) {
    super()
    this.opts = {
      ...opts,
      binary: opts.binary ?? 'opencode',
      hostname: opts.hostname ?? '127.0.0.1',
      startupTimeoutMs: opts.startupTimeoutMs ?? 10_000,
      disposeOnStop: opts.disposeOnStop ?? true,
    }
  }

  get serverUrl(): string | null {
    return this.url
  }

  /** OS pid of the spawned `opencode serve` child, or null before start
   *  / after exit. Exposed so the Agent Code session wrapper can answer
   *  `getProcessPid()` for performance attribution — the same reason
   *  the PTY-based providers surface their node-pty pid. The server is a
   *  real child we own in spawn mode, so this is the process whose CPU/
   *  RSS belongs to the pane. Null in attach mode (we didn't spawn it). */
  get pid(): number | null {
    return this.child?.pid ?? null
  }

  async start(): Promise<SpawnedServerInfo> {
    if (this.child && this.url) return { child: this.child, url: this.url }

    const args = ['serve', '--hostname', this.opts.hostname]
    if (typeof this.opts.port === 'number') args.push('--port', String(this.opts.port))
    if (this.opts.pure) args.push('--pure')

    const env = {
      ...process.env,
      ...this.opts.env,
    }
    if (this.opts.configContent) env.OPENCODE_CONFIG_CONTENT = this.opts.configContent
    if (this.opts.password) env.OPENCODE_SERVER_PASSWORD = this.opts.password

    const child = spawn(this.opts.binary, args, {
      cwd: this.opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child

    // WHY stdout is parsed instead of probing ports: OpenCode's own SDK uses
    // the listen line as the readiness contract. Binding to port 0 only works
    // if we let the process tell us which port it chose; guessing or scanning
    // would race with other local servers and make attach-vs-spawn ambiguous.
    return await new Promise<SpawnedServerInfo>((resolve, reject) => {
      let settled = false
      let stdoutBuffer = ''
      let stderrBuffer = ''
      const timer = setTimeout(() => {
        fail(
          new Error(`Timed out waiting for ${this.opts.binary} serve to report its URL`),
          true,
        )
      }, this.opts.startupTimeoutMs)

      const fail = (err: Error, terminate: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.child === child) this.child = null
        this.url = null
        // WHY a failed start must own termination: callers cannot call stop()
        // reliably after start() rejects, and the old implementation cleared
        // neither the reference nor the process. A server that never prints a
        // listen line would therefore survive the rejected promise and keep its
        // port/process alive for the rest of the Agent Code session.
        if (terminate) terminateChild(child)
        reject(err)
      }

      child.stdout.on('data', chunk => {
        const text = String(chunk)
        stdoutBuffer += text
        this.emit('stdout', text)
        for (const line of stdoutBuffer.split(/\r?\n/)) {
          const parsed = parseListenLine(line)
          if (!parsed) continue
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.url = parsed.url
          resolve({ child, url: parsed.url })
          return
        }
        const lastNewline = Math.max(stdoutBuffer.lastIndexOf('\n'), stdoutBuffer.lastIndexOf('\r'))
        if (lastNewline >= 0) stdoutBuffer = stdoutBuffer.slice(lastNewline + 1)
      })

      child.stderr.on('data', chunk => {
        const text = String(chunk)
        stderrBuffer += text
        this.emit('stderr', text)
      })

      child.once('error', err => fail(err, false))
      child.once('exit', (exitCode, signal) => {
        this.emit('exit', { exitCode, signal })
        if (!settled) {
          fail(
            new Error(
              `${this.opts.binary} serve exited before readiness` +
                (stderrBuffer ? `: ${stderrBuffer.trim()}` : ''),
            ),
            false,
          )
        }
      })
    })
  }

  async stop(dispose?: (url: string) => Promise<void>): Promise<void> {
    const child = this.child
    const url = this.url
    this.child = null
    this.url = null

    if (url && this.opts.disposeOnStop && dispose) {
      try {
        await dispose(url)
      } catch {
        // OpenCode may already be exiting because the child received a signal.
        // Shutdown should be best-effort so cleanup paths do not mask the
        // original caller error.
      }
    }

    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        // ChildProcess.killed only means kill() was called; it does not prove
        // the process exited. Inspect terminal state so a child that ignores
        // SIGTERM still receives the promised hard-stop escalation.
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
        resolve()
      }, 2_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

function terminateChild(child: OpenCodeServerProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')

  // WHY this escalation is detached from the rejected start promise: callers
  // need the readiness failure immediately, but process ownership continues
  // after rejection. An unref'ed timer guarantees eventual cleanup without
  // keeping an otherwise-finished CLI process alive for two extra seconds.
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }, 2_000)
  timer.unref()
  child.once('exit', () => clearTimeout(timer))
}
