// Three-channel truth model for opencode-headless.
//
// WHY this package keeps the same semantic / screen / committed split as the
// Claude and Codex wrappers even though OpenCode does not need a terminal:
//
// OpenCode solves the transport problem for us by exposing structured HTTP and
// SSE, but downstream consumers still need the same conceptual surfaces:
//
//   semantic  - what the model is producing right now
//   screen    - user-visible UI/overlay state, synthetic for OpenCode
//   committed - durable session history fetched from OpenCode storage
//
// A tempting implementation would expose raw OpenCode bus events and make the
// application understand another provider vocabulary. That is exactly the
// integration tax these headless packages are meant to absorb. Keeping the
// split here lets Agent Code treat Claude, Codex, and OpenCode as providers
// with different transports but the same high-level contract.

export type SemanticSource = 'opencode-sse' | 'opencode-history'
export type SemanticConfidence = 'high' | 'medium' | 'fallback'
export type StreamPhase =
  | 'idle'
  | 'thinking'
  | 'responding'
  | 'tool-input'
  | 'awaiting-tool'
  | 'tool-running'

export type SemanticTurnStartedEvent = {
  type: 'turn_started'
  turnId: string
  role: 'user' | 'assistant'
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

export type SemanticTurnDeltaEvent = {
  type: 'turn_delta'
  turnId: string
  textDelta?: string
  fullText: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

export type SemanticTurnCompletedEvent = {
  type: 'turn_completed'
  turnId: string
  fullText?: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

export type SemanticStreamPhaseEvent = {
  type: 'stream_phase'
  turnId: string | null
  phase: StreamPhase
  source: SemanticSource
  ts: number
}

export type SemanticBlockKind = 'text' | 'reasoning' | 'tool' | 'unknown'

export type SemanticBlockRef = {
  turnId: string
  blockId: string
  blockIndex?: number
}

export type SemanticBlockStartedEvent = SemanticBlockRef & {
  type: 'block_started'
  kind: SemanticBlockKind
  name?: string
  source: SemanticSource
  ts: number
}

export type SemanticTextDeltaEvent = SemanticBlockRef & {
  type: 'text_delta'
  textDelta: string
  fullText: string
  source: SemanticSource
  ts: number
}

export type SemanticThinkingDeltaEvent = SemanticBlockRef & {
  type: 'thinking_delta'
  textDelta: string
  fullText: string
  source: SemanticSource
  ts: number
}

export type SemanticToolInputDeltaEvent = SemanticBlockRef & {
  type: 'tool_input_delta'
  inputDelta: string
  fullInput: string
  name?: string
  source: SemanticSource
  ts: number
}

export type SemanticToolInputFinalizedEvent = SemanticBlockRef & {
  type: 'tool_input_finalized'
  input: unknown
  name?: string
  source: SemanticSource
  ts: number
}

export type SemanticToolResultEvent = {
  type: 'tool_result'
  turnId: string
  toolUseId: string
  name?: string
  content: string
  isError: boolean
  source: SemanticSource
  ts: number
}

export type SemanticBlockCompletedEvent = SemanticBlockRef & {
  type: 'block_completed'
  kind: SemanticBlockKind
  name?: string
  source: SemanticSource
  ts: number
}

export type SemanticUsageEvent = {
  type: 'usage_updated'
  turnId: string | null
  usage: unknown
  source: SemanticSource
  ts: number
}

export type SemanticApiErrorEvent = {
  type: 'api_error'
  turnId: string | null
  message: string
  error?: unknown
  source: SemanticSource
  ts: number
}

export type SemanticUnknownEvent = {
  type: 'unknown_event'
  upstreamType: string
  event: unknown
  source: SemanticSource
  ts: number
}

export type SemanticEvent =
  | SemanticTurnStartedEvent
  | SemanticTurnDeltaEvent
  | SemanticTurnCompletedEvent
  | SemanticStreamPhaseEvent
  | SemanticBlockStartedEvent
  | SemanticTextDeltaEvent
  | SemanticThinkingDeltaEvent
  | SemanticToolInputDeltaEvent
  | SemanticToolInputFinalizedEvent
  | SemanticToolResultEvent
  | SemanticBlockCompletedEvent
  | SemanticUsageEvent
  | SemanticApiErrorEvent
  | SemanticUnknownEvent

export type ScreenSnapshotEvent = {
  type: 'snapshot'
  plain: string
  markdown: string
  ts: number
}

export type ScreenActivityEvent = {
  type: 'activity'
  active: boolean
  status: string | null
  ts: number
}

export type ScreenPermissionEvent = {
  type: 'permission'
  state: {
    visible: boolean
    requestID?: string
    sessionID?: string
    title?: string
    metadata?: unknown
  }
  ts: number
}

export type ScreenQuestionEvent = {
  type: 'question'
  state: {
    visible: boolean
    questionID?: string
    sessionID?: string
    text?: string
    metadata?: unknown
  }
  ts: number
}

export type ScreenCompactionEvent = {
  type: 'compaction'
  state: {
    active: boolean
    sessionID?: string
    metadata?: unknown
  }
  ts: number
}

export type ScreenFileEvent = {
  type: 'file'
  action: 'edited' | 'watcher'
  sessionID?: string
  path?: string
  metadata?: unknown
  ts: number
}

export type ScreenSystemEvent = {
  type: 'system'
  category:
    | 'mcp'
    | 'command'
    | 'project'
    | 'vcs'
    | 'workspace'
    | 'worktree'
    | 'pty'
    | 'lsp'
    | 'installation'
    | 'catalog'
    | 'tui'
    | 'global'
    | 'unknown'
  action: string
  sessionID?: string
  message?: string
  metadata?: unknown
  ts: number
}

export type ScreenEvent =
  | ScreenSnapshotEvent
  | ScreenActivityEvent
  | ScreenPermissionEvent
  | ScreenQuestionEvent
  | ScreenCompactionEvent
  | ScreenFileEvent
  | ScreenSystemEvent

export type CommittedEntryEvent = {
  type: 'entry'
  sessionID: string
  message: unknown
  ts: number
}

export type CommittedTurnEvent = {
  type: 'turn_committed'
  sessionID: string
  turnId: string
  role: 'user' | 'assistant'
  text: string
  message: unknown
  ts: number
}

export type CommittedCompactBoundaryEvent = {
  type: 'compact_boundary'
  sessionID: string
  message: unknown
  ts: number
}

export type CommittedEvent =
  | CommittedEntryEvent
  | CommittedTurnEvent
  | CommittedCompactBoundaryEvent
