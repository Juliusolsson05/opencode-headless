import type { SemanticSource, StreamPhase } from '../channels/types.js'
import { SemanticChannel } from '../channels/SemanticChannel.js'

export type TurnTrackerOptions = {
  semantic: SemanticChannel
  source?: SemanticSource
  // WHY this hook exists: the tracker owns turn lifecycle but the dispatcher
  // owns block lifecycle (openBlocks keyed by partID). ensureTurn() completes
  // the previous turn *internally* when a new turnId shows up, so without this
  // hook the dispatcher never gets a chance to emit block_completed for blocks
  // that were still streaming when the turn rolled over — consumers would see
  // block_started with no matching close, forever. The hook fires before
  // turn_completed so the event order downstream folds cleanly:
  // block_completed* -> turn_completed -> stream_phase(idle).
  onBeforeComplete?: (turnId: string) => void
}

export class TurnTracker {
  private readonly semantic: SemanticChannel
  private readonly source: SemanticSource
  private readonly onBeforeComplete?: (turnId: string) => void
  private activeTurnId: string | null = null
  private phase: StreamPhase = 'idle'
  private fullText = ''

  constructor(opts: TurnTrackerOptions) {
    this.semantic = opts.semantic
    this.source = opts.source ?? 'opencode-sse'
    this.onBeforeComplete = opts.onBeforeComplete
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

  // WHY the `force` escape hatch: the change-dedupe below is right for
  // mid-stream transitions (a setPhase('responding') per text delta must
  // collapse to one event), but it silently broke turn completion. A verified
  // debug bundle showed a text-only turn where the phase never left 'idle'
  // (nothing ever called setPhase during the turn), so completeTurn()'s
  // setPhase('idle') no-oped and the renderer never received ANY stream_phase
  // event for the whole session — it sat on whatever phase it had. Turn
  // completion therefore always force-publishes idle: an extra idempotent
  // idle event is free, a missing one wedges the renderer.
  setPhase(phase: StreamPhase, opts: { force?: boolean } = {}): void {
    if (!opts.force && this.phase === phase) return
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
      // No turn to complete (session.idle / session.status can fire without a
      // live turn) — still force-publish idle so a renderer that missed
      // earlier events is guaranteed to unstick. See setPhase comment.
      this.setPhase('idle', { force: true })
      return
    }
    const turnId = this.activeTurnId
    if (typeof fullText === 'string') this.fullText = fullText
    this.onBeforeComplete?.(turnId)
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
    this.setPhase('idle', { force: true })
  }
}
