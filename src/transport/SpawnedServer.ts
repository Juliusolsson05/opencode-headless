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
        if (settled) return
        settled = true
        reject(new Error(`Timed out waiting for ${this.opts.binary} serve to report its URL`))
      }, this.opts.startupTimeoutMs)

      const fail = (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
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

      child.once('error', fail)
      child.once('exit', (exitCode, signal) => {
        this.emit('exit', { exitCode, signal })
        if (!settled) {
          fail(
            new Error(
              `${this.opts.binary} serve exited before readiness` +
                (stderrBuffer ? `: ${stderrBuffer.trim()}` : ''),
            ),
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

    if (!child || child.killed) return
    child.kill('SIGTERM')
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
        resolve()
      }, 2_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
