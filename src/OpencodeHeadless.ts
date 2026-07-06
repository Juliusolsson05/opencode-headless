import { EventEmitter } from 'events'

import { CommittedChannel } from './channels/CommittedChannel.js'
import { ScreenChannel } from './channels/ScreenChannel.js'
import { SemanticChannel } from './channels/SemanticChannel.js'
import type { CommittedEvent, ScreenEvent, SemanticEvent } from './channels/types.js'
import { EventDispatcher, type OpenCodeBusEvent } from './dispatcher/EventDispatcher.js'
import { PartAccumulator } from './dispatcher/partAccumulator.js'
import { PermissionService, type OpenCodePermissionRequest } from './permissions/PermissionService.js'
import { HistoryClient } from './transcript/HistoryClient.js'
import { SpawnedServer } from './transport/SpawnedServer.js'
import { SseClient, type SseMessage } from './transport/SseClient.js'
import {
  SyncClient,
  type ModelSelection,
  type PromptOptions,
  type QuestionAnswer,
} from './transport/SyncClient.js'

export type OpencodeHeadlessMode = 'spawn' | 'attach'

export type OpencodeHeadlessOptions = {
  mode?: OpencodeHeadlessMode
  cwd: string
  serverUrl?: string
  binary?: string
  hostname?: string
  port?: number
  password?: string
  env?: NodeJS.ProcessEnv
  configContent?: string
  pure?: boolean
  sessionID?: string
  startupTimeoutMs?: number
  fetch?: typeof fetch
  autoReconnectSse?: boolean
}

export type OpencodePromptInput = Omit<PromptOptions, 'sessionID'> & {
  sessionID?: string
}

export type OpencodeHeadlessEvent =
  | { type: 'ready'; ts: number; url: string; sessionID: string | null }
  | { type: 'session'; ts: number; sessionID: string }
  | { type: 'raw'; ts: number; event: OpenCodeBusEvent }
  | { type: 'semantic'; ts: number; event: SemanticEvent }
  | { type: 'screen'; ts: number; event: ScreenEvent }
  | { type: 'committed'; ts: number; event: CommittedEvent }
  | { type: 'permission'; ts: number; request: OpenCodePermissionRequest }
  | { type: 'sse_error'; ts: number; error: Error }
  | { type: 'exit'; ts: number; exitCode: number | null; signal: NodeJS.Signals | null }

export type OpencodeHeadlessEvents = {
  event: [OpencodeHeadlessEvent]
  ready: [{ url: string; sessionID: string | null }]
  session: [string]
  raw: [OpenCodeBusEvent]
  permission: [OpenCodePermissionRequest]
  'sse-error': [Error]
  exit: [{ exitCode: number | null; signal: NodeJS.Signals | null }]
}

export interface OpencodeHeadless {
  on<K extends keyof OpencodeHeadlessEvents>(
    event: K,
    listener: (...args: OpencodeHeadlessEvents[K]) => void,
  ): this
  off<K extends keyof OpencodeHeadlessEvents>(
    event: K,
    listener: (...args: OpencodeHeadlessEvents[K]) => void,
  ): this
  emit<K extends keyof OpencodeHeadlessEvents>(
    event: K,
    ...args: OpencodeHeadlessEvents[K]
  ): boolean
}

export class OpencodeHeadless extends EventEmitter {
  readonly semantic = new SemanticChannel()
  readonly screen = new ScreenChannel()
  readonly committed = new CommittedChannel()

  private readonly opts: OpencodeHeadlessOptions
  private readonly mode: OpencodeHeadlessMode
  private spawned: SpawnedServer | null = null
  private sse: SseClient | null = null
  private sync: SyncClient | null = null
  private dispatcher: EventDispatcher | null = null
  private history: HistoryClient | null = null
  private permissions: PermissionService | null = null
  private sessionID: string | null
  private url: string | null = null

  constructor(opts: OpencodeHeadlessOptions) {
    super()
    this.opts = opts
    this.mode = opts.mode ?? (opts.serverUrl ? 'attach' : 'spawn')
    this.sessionID = opts.sessionID ?? null
    this.forwardChannels()
  }

  get serverUrl(): string | null {
    return this.url
  }

  get activeSessionID(): string | null {
    return this.sessionID
  }

  /** OS pid of the spawned server child (spawn mode), or null in attach
   *  mode / before start / after exit. Forwarded from SpawnedServer so
   *  the Agent Code wrapper can implement AgentSession.getProcessPid()
   *  without reaching into transport internals. */
  get processPid(): number | null {
    return this.spawned?.pid ?? null
  }

  get client(): SyncClient {
    if (!this.sync) throw new Error('OpencodeHeadless has not been started')
    return this.sync
  }

  get permissionService(): PermissionService {
    if (!this.permissions) throw new Error('OpencodeHeadless has not been started')
    return this.permissions
  }

  async start(): Promise<void> {
    const url = await this.resolveServerUrl()
    this.url = url
    this.sync = new SyncClient({
      baseUrl: url,
      cwd: this.opts.cwd,
      password: this.opts.password,
      fetch: this.opts.fetch,
    })
    this.permissions = new PermissionService(this.sync)
    this.history = new HistoryClient(this.sync, this.committed)
    const accumulator = new PartAccumulator({
      onOverflow: overflow => {
        this.semantic.publish({
          type: 'api_error',
          turnId: this.semantic.getActiveTurnId(),
          message: `OpenCode part ${overflow.partID} exceeded the in-memory delta buffer`,
          error: overflow,
          source: 'opencode-sse',
          ts: Date.now(),
        })
      },
    })
    this.dispatcher = new EventDispatcher({
      semantic: this.semantic,
      screen: this.screen,
      committed: this.committed,
      sessionID: this.sessionID ?? undefined,
      accumulator,
    })

    if (this.sessionID) {
      await this.history.publishSessionMessages(this.sessionID)
    }

    this.startSse()
    this.emitReady()
  }

  async createSession(input: Record<string, unknown> = {}): Promise<string> {
    const data = await this.client.createSession(input)
    const id = extractID(data)
    if (!id) throw new Error('OpenCode did not return a session id')
    this.setSessionID(id)
    return id
  }

  async ensureSession(input: Record<string, unknown> = {}): Promise<string> {
    if (this.sessionID) return this.sessionID
    return await this.createSession(input)
  }

  async prompt(input: OpencodePromptInput): Promise<unknown> {
    const sessionID = input.sessionID ?? (await this.ensureSession())
    return await this.client.prompt({
      ...input,
      sessionID,
    })
  }

  async command(command: string, sessionID = this.sessionID): Promise<unknown> {
    if (!sessionID) throw new Error('No OpenCode session is active')
    return await this.client.command(sessionID, command)
  }

  async shell(
    command: string,
    opts: { sessionID?: string; agent?: string } & ModelSelection = {},
  ): Promise<unknown> {
    const sessionID = opts.sessionID ?? this.sessionID
    if (!sessionID) throw new Error('No OpenCode session is active')
    return await this.client.shell(sessionID, command, opts)
  }

  async listPermissions(): Promise<unknown[]> {
    return await this.client.listPermissions()
  }

  async listQuestions(): Promise<unknown[]> {
    return await this.client.listQuestions()
  }

  async replyQuestion(requestID: string, answers: QuestionAnswer[]): Promise<unknown> {
    return await this.client.replyQuestion(requestID, answers)
  }

  async rejectQuestion(requestID: string): Promise<unknown> {
    return await this.client.rejectQuestion(requestID)
  }

  async abort(sessionID = this.sessionID): Promise<unknown> {
    if (!sessionID) throw new Error('No OpenCode session is active')
    return await this.client.abort(sessionID)
  }

  async refreshHistory(sessionID = this.sessionID): Promise<unknown[]> {
    if (!sessionID) throw new Error('No OpenCode session is active')
    if (!this.history) throw new Error('OpencodeHeadless has not been started')
    return await this.history.publishSessionMessages(sessionID)
  }

  async stop(): Promise<void> {
    this.sse?.stop()
    this.sse = null
    const sync = this.sync
    this.sync = null
    this.dispatcher = null
    this.history = null
    this.permissions = null
    if (this.spawned) {
      const spawned = this.spawned
      this.spawned = null
      await spawned.stop(sync ? () => sync.disposeInstance().then(() => undefined) : undefined)
    }
  }

  private async resolveServerUrl(): Promise<string> {
    if (this.mode === 'attach') {
      if (!this.opts.serverUrl) throw new Error('mode=attach requires serverUrl')
      return this.opts.serverUrl
    }

    this.spawned = new SpawnedServer({
      binary: this.opts.binary,
      cwd: this.opts.cwd,
      hostname: this.opts.hostname,
      port: this.opts.port,
      env: this.opts.env,
      configContent: this.opts.configContent,
      pure: this.opts.pure,
      password: this.opts.password,
      startupTimeoutMs: this.opts.startupTimeoutMs,
    })
    this.spawned.on('exit', ev => {
      this.emit('exit', ev)
      this.emit('event', { type: 'exit', ts: Date.now(), ...ev })
    })
    const info = await this.spawned.start()
    return info.url
  }

  private startSse(): void {
    if (!this.sync) throw new Error('Sync client not initialized')
    this.sse = new SseClient({
      url: this.sync.eventUrl(),
      headers: this.sync.headers(),
      fetch: this.opts.fetch,
      retryMs: this.opts.autoReconnectSse === false ? Number.MAX_SAFE_INTEGER : 1_000,
    })
    this.sse.on('message', msg => this.handleSseMessage(msg))
    this.sse.on('error', err => {
      this.emit('sse-error', err)
      this.emit('event', { type: 'sse_error', ts: Date.now(), error: err })
    })
    this.sse.start()
  }

  private handleSseMessage(msg: SseMessage): void {
    if (!msg.data || msg.data === '[DONE]') return
    let parsed: unknown
    try {
      parsed = JSON.parse(msg.data)
    } catch {
      return
    }
    const event = normalizeBusEvent(parsed, msg.event)
    if (!event || !this.dispatcher) return
    this.emit('raw', event)
    this.emit('event', { type: 'raw', ts: Date.now(), event })
    if (event.type === 'session.created' || event.type === 'session.updated') {
      const id = extractSessionIDFromEvent(event)
      if (id) this.setSessionID(id)
    }
    if (event.type === 'permission.asked' || event.type === 'permission.updated') {
      const req = permissionRequestFromEvent(event)
      if (req && this.permissions) {
        this.permissions.remember(req)
        this.emit('permission', req)
        this.emit('event', { type: 'permission', ts: Date.now(), request: req })
      }
    }
    this.dispatcher.dispatch(event)
  }

  private setSessionID(sessionID: string): void {
    this.sessionID = sessionID
    this.dispatcher?.setSessionID(sessionID)
    this.emit('session', sessionID)
    this.emit('event', { type: 'session', ts: Date.now(), sessionID })
  }

  private emitReady(): void {
    if (!this.url) return
    const payload = { url: this.url, sessionID: this.sessionID }
    this.emit('ready', payload)
    this.emit('event', { type: 'ready', ts: Date.now(), ...payload })
  }

  private forwardChannels(): void {
    this.semantic.on('event', event => {
      this.emit('event', { type: 'semantic', ts: Date.now(), event })
    })
    this.screen.on('event', event => {
      this.emit('event', { type: 'screen', ts: Date.now(), event })
    })
    this.committed.on('event', event => {
      this.emit('event', { type: 'committed', ts: Date.now(), event })
    })
  }
}

function normalizeBusEvent(value: unknown, eventName?: string): OpenCodeBusEvent | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const type = typeof obj.type === 'string' ? obj.type : eventName
  if (!type) return null
  return {
    ...obj,
    type,
  }
}

function extractID(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  for (const key of ['id', 'sessionID', 'sessionId']) {
    if (typeof obj[key] === 'string') return obj[key] as string
  }
  const nested = obj.session
  if (nested && typeof nested === 'object') return extractID(nested)
  const data = obj.data
  if (data && typeof data === 'object') return extractID(data)
  return null
}

function extractSessionIDFromEvent(event: OpenCodeBusEvent): string | null {
  // WHY this is separate from the generic response-id helper:
  // OpenCode bus envelopes have their own `id` (`evt_...`) and a session id in
  // `properties.sessionID`. Treating every top-level `id` as a session id made
  // the wrapper report event ids as active sessions after `session.updated`.
  // Session identity must come from the event payload, never the envelope.
  const props =
    event.properties && typeof event.properties === 'object'
      ? (event.properties as Record<string, unknown>)
      : event
  return firstString(props, ['sessionID', 'sessionId']) ?? extractID(props.session)
}

function permissionRequestFromEvent(event: OpenCodeBusEvent): OpenCodePermissionRequest | null {
  const payload =
    event.properties && typeof event.properties === 'object'
      ? (event.properties as Record<string, unknown>)
      : event
  const requestID = firstString(payload, ['requestID', 'permissionID', 'id'])
  if (!requestID) return null
  return {
    requestID,
    sessionID: firstString(payload, ['sessionID', 'sessionId']),
    title: firstString(payload, ['title', 'tool', 'action']),
    metadata: payload,
  }
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}
