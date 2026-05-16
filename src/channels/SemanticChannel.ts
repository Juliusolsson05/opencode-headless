import { EventEmitter } from 'events'

import type {
  SemanticApiErrorEvent,
  SemanticBlockCompletedEvent,
  SemanticBlockStartedEvent,
  SemanticEvent,
  SemanticTextDeltaEvent,
  SemanticThinkingDeltaEvent,
  SemanticToolInputDeltaEvent,
  SemanticToolInputFinalizedEvent,
  SemanticToolResultEvent,
  SemanticTurnCompletedEvent,
  SemanticTurnDeltaEvent,
  SemanticTurnStartedEvent,
  SemanticUnknownEvent,
  SemanticUsageEvent,
  SemanticStreamPhaseEvent,
} from './types.js'

export type SemanticChannelEvents = {
  event: [SemanticEvent]
  turn_started: [SemanticTurnStartedEvent]
  turn_delta: [SemanticTurnDeltaEvent]
  turn_completed: [SemanticTurnCompletedEvent]
  stream_phase: [SemanticStreamPhaseEvent]
  block_started: [SemanticBlockStartedEvent]
  text_delta: [SemanticTextDeltaEvent]
  thinking_delta: [SemanticThinkingDeltaEvent]
  tool_input_delta: [SemanticToolInputDeltaEvent]
  tool_input_finalized: [SemanticToolInputFinalizedEvent]
  tool_result: [SemanticToolResultEvent]
  block_completed: [SemanticBlockCompletedEvent]
  usage_updated: [SemanticUsageEvent]
  api_error: [SemanticApiErrorEvent]
  unknown_event: [SemanticUnknownEvent]
}

export interface SemanticChannel {
  on<K extends keyof SemanticChannelEvents>(
    event: K,
    listener: (...args: SemanticChannelEvents[K]) => void,
  ): this
  off<K extends keyof SemanticChannelEvents>(
    event: K,
    listener: (...args: SemanticChannelEvents[K]) => void,
  ): this
  emit<K extends keyof SemanticChannelEvents>(
    event: K,
    ...args: SemanticChannelEvents[K]
  ): boolean
}

export class SemanticChannel extends EventEmitter {
  private activeTurnId: string | null = null
  private lastFullText = ''

  getActiveTurnId(): string | null {
    return this.activeTurnId
  }

  getLastFullText(): string {
    return this.lastFullText
  }

  publishTurnStarted(ev: SemanticTurnStartedEvent): void {
    if (this.activeTurnId === ev.turnId) return
    this.activeTurnId = ev.turnId
    this.lastFullText = ''
    this.emit('turn_started', ev)
    this.emit('event', ev)
  }

  publishTurnDelta(ev: SemanticTurnDeltaEvent): void {
    if (!this.activeTurnId) {
      this.publishTurnStarted({
        type: 'turn_started',
        turnId: ev.turnId,
        role: 'assistant',
        source: ev.source,
        confidence: ev.confidence,
        ts: ev.ts,
      })
    }
    this.lastFullText = ev.fullText
    this.emit('turn_delta', ev)
    this.emit('event', ev)
  }

  publishTurnCompleted(ev: SemanticTurnCompletedEvent): void {
    if (typeof ev.fullText === 'string') this.lastFullText = ev.fullText
    this.activeTurnId = null
    this.emit('turn_completed', ev)
    this.emit('event', ev)
  }

  publish<E extends Exclude<
    SemanticEvent,
    SemanticTurnStartedEvent | SemanticTurnDeltaEvent | SemanticTurnCompletedEvent
  >>(ev: E): void {
    switch (ev.type) {
      case 'stream_phase':
        this.emit('stream_phase', ev)
        break
      case 'block_started':
        this.emit('block_started', ev)
        break
      case 'text_delta':
        this.emit('text_delta', ev)
        break
      case 'thinking_delta':
        this.emit('thinking_delta', ev)
        break
      case 'tool_input_delta':
        this.emit('tool_input_delta', ev)
        break
      case 'tool_input_finalized':
        this.emit('tool_input_finalized', ev)
        break
      case 'tool_result':
        this.emit('tool_result', ev)
        break
      case 'block_completed':
        this.emit('block_completed', ev)
        break
      case 'usage_updated':
        this.emit('usage_updated', ev)
        break
      case 'api_error':
        this.emit('api_error', ev)
        break
      case 'unknown_event':
        this.emit('unknown_event', ev)
        break
    }
    this.emit('event', ev)
  }
}
