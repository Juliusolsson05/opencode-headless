import type { SemanticSource, StreamPhase } from '../channels/types.js'
import { SemanticChannel } from '../channels/SemanticChannel.js'

export type TurnTrackerOptions = {
  semantic: SemanticChannel
  source?: SemanticSource
}

export class TurnTracker {
  private readonly semantic: SemanticChannel
  private readonly source: SemanticSource
  private activeTurnId: string | null = null
  private phase: StreamPhase = 'idle'
  private fullText = ''

  constructor(opts: TurnTrackerOptions) {
    this.semantic = opts.semantic
    this.source = opts.source ?? 'opencode-sse'
  }

  getActiveTurnId(): string | null {
    return this.activeTurnId
  }

  getFullText(): string {
    return this.fullText
  }

  ensureTurn(turnId: string, role: 'user' | 'assistant' = 'assistant'): void {
    if (this.activeTurnId === turnId) return
    if (this.activeTurnId) this.completeTurn()
    this.activeTurnId = turnId
    this.fullText = ''
    this.semantic.publishTurnStarted({
      type: 'turn_started',
      turnId,
      role,
      source: this.source,
      confidence: 'high',
      ts: Date.now(),
    })
  }

  appendText(turnId: string, textDelta: string, fullText?: string): void {
    this.ensureTurn(turnId, 'assistant')
    this.fullText = typeof fullText === 'string' ? fullText : this.fullText + textDelta
    this.semantic.publishTurnDelta({
      type: 'turn_delta',
      turnId,
      textDelta,
      fullText: this.fullText,
      source: this.source,
      confidence: 'high',
      ts: Date.now(),
    })
  }

  setPhase(phase: StreamPhase): void {
    if (this.phase === phase) return
    this.phase = phase
    this.semantic.publish({
      type: 'stream_phase',
      turnId: this.activeTurnId,
      phase,
      source: this.source,
      ts: Date.now(),
    })
  }

  completeTurn(fullText?: string): void {
    if (!this.activeTurnId) {
      this.setPhase('idle')
      return
    }
    const turnId = this.activeTurnId
    if (typeof fullText === 'string') this.fullText = fullText
    this.semantic.publishTurnCompleted({
      type: 'turn_completed',
      turnId,
      fullText: this.fullText,
      source: this.source,
      confidence: 'high',
      ts: Date.now(),
    })
    this.activeTurnId = null
    this.fullText = ''
    this.setPhase('idle')
  }
}
