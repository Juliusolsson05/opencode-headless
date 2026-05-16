import { CommittedChannel } from '../channels/CommittedChannel.js'
import { ScreenChannel } from '../channels/ScreenChannel.js'
import { SemanticChannel } from '../channels/SemanticChannel.js'
import { PartAccumulator } from './partAccumulator.js'
import { TurnTracker } from './turnTracker.js'

export type OpenCodeBusEvent = {
  type: string
  [key: string]: unknown
}

export type EventDispatcherOptions = {
  semantic: SemanticChannel
  screen: ScreenChannel
  committed: CommittedChannel
  sessionID?: string
  accumulator?: PartAccumulator
}

export class EventDispatcher {
  private readonly semantic: SemanticChannel
  private readonly screen: ScreenChannel
  private readonly committed: CommittedChannel
  private readonly accumulator: PartAccumulator
  private readonly turns: TurnTracker
  private readonly messageRoles = new Map<string, 'user' | 'assistant'>()
  private sessionID: string | null

  constructor(opts: EventDispatcherOptions) {
    this.semantic = opts.semantic
    this.screen = opts.screen
    this.committed = opts.committed
    this.accumulator = opts.accumulator ?? new PartAccumulator()
    this.turns = new TurnTracker({ semantic: opts.semantic })
    this.sessionID = opts.sessionID ?? null
  }

  setSessionID(sessionID: string | null): void {
    this.sessionID = sessionID
  }

  dispatch(event: OpenCodeBusEvent): void {
    const type = event.type
    const payload = payloadOf(event)

    // WHY this switch is deliberately stringly-typed:
    // OpenCode's SDK-generated union is the ideal compile-time source, but the
    // first package version intentionally avoids a dependency that would modify
    // root lockfiles and constrain host installs. Keeping all raw event names in
    // this one file gives us the same migration point: once `@opencode-ai/sdk/v2`
    // is accepted, replace OpenCodeBusEvent with its union and let TypeScript
    // force this switch to become exhaustive.
    switch (type) {
      case 'server.connected':
      case 'server.heartbeat':
        return
      case 'server.instance.disposed':
        this.screen.publishActivity({ active: false, status: 'stopped' })
        return

      case 'session.created':
      case 'session.updated':
        this.captureSessionID(payload)
        return

      case 'session.status':
        this.handleSessionStatus(payload)
        return

      case 'session.idle':
        this.screen.publishActivity({ active: false, status: 'idle' })
        this.turns.completeTurn()
        return

      case 'session.compacted':
        this.screen.publishCompaction({
          active: false,
          sessionID: this.eventSessionID(payload),
          metadata: payload,
        })
        return

      case 'message.updated':
        this.handleMessageUpdated(payload)
        return

      case 'message.part.updated':
        this.handlePartUpdated(payload)
        return

      case 'message.part.delta':
        this.handlePartDelta(payload)
        return

      case 'message.part.removed':
      case 'message.removed':
        return

      case 'permission.asked':
      case 'permission.updated':
        this.handlePermission(payload)
        return

      case 'permission.replied':
        this.screen.publishPermission({ visible: false, metadata: payload })
        return

      case 'question.asked':
      case 'question.updated':
        this.handleQuestion(payload)
        return

      case 'question.replied':
        this.screen.publishQuestion({ visible: false, metadata: payload })
        return

      case 'session.error':
        this.semantic.publish({
          type: 'api_error',
          turnId: this.turns.getActiveTurnId(),
          message: getString(payload, ['message', 'error.message']) ?? 'OpenCode session error',
          error: payload,
          source: 'opencode-sse',
          ts: Date.now(),
        })
        return

      case 'file.edited':
      case 'todo.updated':
      case 'command.executed':
      case 'vcs.branch.updated':
      case 'lsp.updated':
      case 'lsp.client.diagnostics':
      case 'pty.created':
      case 'pty.updated':
      case 'pty.exited':
      case 'pty.deleted':
        return

      default:
        this.semantic.publish({
          type: 'unknown_event',
          upstreamType: type,
          event,
          source: 'opencode-sse',
          ts: Date.now(),
        })
    }
  }

  publishHistory(sessionID: string, messages: unknown[]): void {
    for (const message of messages) this.committed.publishMessage(sessionID, message)
  }

  private captureSessionID(payload: unknown): void {
    const id = getString(payload, ['id', 'sessionID', 'session.id'])
    if (id) this.sessionID = id
  }

  private handleSessionStatus(payload: unknown): void {
    const status = getString(payload, ['status', 'state', 'session.status'])
    const active = status !== 'idle' && status !== 'stopped' && status !== 'error'
    this.screen.publishActivity({ active, status: status ?? null })
    if (status === 'idle') this.turns.completeTurn()
    else if (status === 'compacting') {
      this.screen.publishCompaction({
        active: true,
        sessionID: this.eventSessionID(payload),
        metadata: payload,
      })
    }
  }

  private handleMessageUpdated(payload: unknown): void {
    const sessionID = this.eventSessionID(payload)
    if (sessionID) this.committed.publishMessage(sessionID, payload)
    const messageID = getString(payload, ['info.id', 'message.id', 'id'])
    const role = getString(payload, ['info.role', 'message.role', 'role'])
    if (messageID && (role === 'user' || role === 'assistant')) {
      this.messageRoles.set(messageID, role)
    }
    const usage = getUnknown(payload, ['usage', 'message.usage'])
    if (usage) {
      this.semantic.publish({
        type: 'usage_updated',
        turnId: this.turns.getActiveTurnId(),
        usage,
        source: 'opencode-sse',
        ts: Date.now(),
      })
    }
  }

  private handlePartUpdated(payload: unknown): void {
    const part = getUnknown(payload, ['part']) ?? payload
    const partID = getString(part, ['id', 'partID']) ?? stableID('part')
    const turnId = getString(part, ['messageID', 'messageId', 'message.id']) ?? this.turns.getActiveTurnId() ?? partID
    const role =
      getString(part, ['role', 'message.role']) ??
      (turnId ? this.messageRoles.get(turnId) : undefined)
    if (role === 'user') return
    const kind = normalizePartKind(getString(part, ['type', 'kind']))
    const text = getString(part, ['text', 'content', 'summary'])
    const name = getString(part, ['tool', 'name', 'toolName'])
    this.accumulator.applyUpdate(partID, {
      text,
      content: getString(part, ['content']),
      input: stringifyMaybe(getUnknown(part, ['input', 'args'])),
    })

    if (kind === 'text' && typeof text === 'string') {
      const previous = this.accumulator.getField(partID, '__last_text_emitted')
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text
      this.accumulator.applyUpdate(partID, { __last_text_emitted: text })
      if (delta) this.turns.appendText(turnId, delta, this.turns.getFullText() + delta)
      this.semantic.publish({
        type: 'text_delta',
        turnId,
        blockId: partID,
        textDelta: delta,
        fullText: text,
        source: 'opencode-sse',
        ts: Date.now(),
      })
    }

    if (kind === 'reasoning' && typeof text === 'string') {
      this.semantic.publish({
        type: 'thinking_delta',
        turnId,
        blockId: partID,
        textDelta: text,
        fullText: text,
        source: 'opencode-sse',
        ts: Date.now(),
      })
    }

    if (kind === 'tool') {
      const status = getString(part, ['status', 'state'])
      this.turns.ensureTurn(turnId, 'assistant')
      this.semantic.publish({
        type: status === 'completed' || status === 'error' ? 'block_completed' : 'block_started',
        turnId,
        blockId: partID,
        kind: 'tool',
        name,
        source: 'opencode-sse',
        ts: Date.now(),
      })
      const output = getString(part, ['output', 'result', 'metadata.output'])
      if (output || status === 'error') {
        this.semantic.publish({
          type: 'tool_result',
          turnId,
          toolUseId: partID,
          name,
          content: output ?? '',
          isError: status === 'error',
          source: 'opencode-sse',
          ts: Date.now(),
        })
      }
    }
  }

  private handlePartDelta(payload: unknown): void {
    const partID = getString(payload, ['partID', 'id', 'part.id']) ?? stableID('part')
    const turnId =
      getString(payload, ['messageID', 'messageId', 'message.id', 'part.messageID']) ??
      this.turns.getActiveTurnId() ??
      partID
    const role =
      getString(payload, ['role', 'message.role', 'part.role']) ??
      (turnId ? this.messageRoles.get(turnId) : undefined)
    if (role === 'user') return
    const field = getString(payload, ['field']) ?? 'text'
    const delta = getString(payload, ['delta', 'text', 'content']) ?? ''
    if (!delta) return

    const full = this.accumulator.applyDelta(partID, field, delta)
    if (field === 'text' || field === 'content') {
      this.accumulator.applyUpdate(partID, { __last_text_emitted: full })
      this.turns.appendText(turnId, delta)
      this.semantic.publish({
        type: 'text_delta',
        turnId,
        blockId: partID,
        textDelta: delta,
        fullText: full,
        source: 'opencode-sse',
        ts: Date.now(),
      })
      return
    }

    if (field === 'thinking' || field === 'reasoning') {
      this.turns.ensureTurn(turnId, 'assistant')
      this.turns.setPhase('thinking')
      this.semantic.publish({
        type: 'thinking_delta',
        turnId,
        blockId: partID,
        textDelta: delta,
        fullText: full,
        source: 'opencode-sse',
        ts: Date.now(),
      })
      return
    }

    this.turns.ensureTurn(turnId, 'assistant')
    this.turns.setPhase('tool-input')
    this.semantic.publish({
      type: 'tool_input_delta',
      turnId,
      blockId: partID,
      inputDelta: delta,
      fullInput: full,
      source: 'opencode-sse',
      ts: Date.now(),
    })
  }

  private handlePermission(payload: unknown): void {
    const requestID =
      getString(payload, ['requestID', 'permissionID', 'id', 'permission.id']) ?? undefined
    this.screen.publishPermission({
      visible: true,
      requestID,
      sessionID: this.eventSessionID(payload),
      title: getString(payload, ['title', 'tool', 'action', 'permission.action']),
      metadata: payload,
    })
  }

  private handleQuestion(payload: unknown): void {
    this.screen.publishQuestion({
      visible: true,
      questionID: getString(payload, ['questionID', 'id']) ?? undefined,
      sessionID: this.eventSessionID(payload),
      text: getString(payload, ['text', 'question', 'prompt']) ?? undefined,
      metadata: payload,
    })
  }

  private eventSessionID(payload: unknown): string {
    return (
      getString(payload, ['sessionID', 'sessionId', 'session.id']) ??
      this.sessionID ??
      'unknown-session'
    )
  }
}

function payloadOf(event: OpenCodeBusEvent): unknown {
  return event.properties ?? event.payload ?? event
}

function normalizePartKind(kind: string | undefined): 'text' | 'reasoning' | 'tool' | 'unknown' {
  if (!kind) return 'unknown'
  if (kind === 'text' || kind === 'assistant_text') return 'text'
  if (kind === 'reasoning' || kind === 'thinking') return 'reasoning'
  if (kind === 'tool' || kind === 'tool-call' || kind === 'tool_use') return 'tool'
  return 'unknown'
}

function getUnknown(value: unknown, paths: string[]): unknown {
  for (const path of paths) {
    let cur: unknown = value
    for (const key of path.split('.')) {
      if (!cur || typeof cur !== 'object' || !(key in cur)) {
        cur = undefined
        break
      }
      cur = (cur as Record<string, unknown>)[key]
    }
    if (cur !== undefined && cur !== null) return cur
  }
  return undefined
}

function getString(value: unknown, paths: string[]): string | undefined {
  const found = getUnknown(value, paths)
  return typeof found === 'string' && found ? found : undefined
}

function stringifyMaybe(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return undefined
  return JSON.stringify(value)
}

function stableID(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
