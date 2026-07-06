import { CommittedChannel } from '../channels/CommittedChannel.js'
import { ScreenChannel } from '../channels/ScreenChannel.js'
import { SemanticChannel } from '../channels/SemanticChannel.js'
import type { SemanticBlockKind } from '../channels/types.js'
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

  // WHY the dispatcher tracks part kind separately from the wire `field`:
  // OpenCode's processor publishes reasoning deltas as `message.part.delta`
  // with `field: "text"` — byte-identical to answer-text deltas (see
  // opencode session/processor.ts `reasoning-delta` vs `text-delta`, both
  // `field: "text"`). The ONLY way to tell them apart is the part `type`
  // carried by the `message.part.updated` snapshot that always precedes the
  // deltas (reasoning-start/text-start both call updatePart first). A live
  // debug bundle proved what happens without this map: reasoning text was
  // concatenated straight into the answer ("…extra skills!I can help…") and
  // the transcript rendered thinking as answer prose.
  private readonly partKinds = new Map<string, SemanticBlockKind>()

  // Blocks that got a block_started but no block_completed yet, keyed by
  // blockId (partID / callID). Needed so (a) block_started is emitted exactly
  // once per block even though OpenCode re-publishes part snapshots on every
  // state change, and (b) turn completion can close any block the stream
  // never explicitly ended (TurnTracker calls back into
  // closeOpenBlocksForTurn before publishing turn_completed).
  private readonly openBlocks = new Map<
    string,
    { turnId: string; kind: SemanticBlockKind; name?: string }
  >()

  // WHY we assemble committed messages ourselves: the wire `message.updated`
  // payload is `{sessionID, info}` — NO parts (opencode message-v2.ts
  // UpdatedEventSchema). The app's committed-message mapper requires
  // `{info, parts}` and maps a parts-less payload to zero entries, so
  // republishing the raw payload (the old behavior) meant live turns NEVER
  // produced a durable transcript line — the bundle showed committed messages
  // arriving parts-less and nothing rendering after a reload. We therefore
  // buffer the latest part snapshots per messageID (message.part.updated
  // carries the full part each time, including final text at text-end /
  // reasoning-end) and publish ONE assembled `{info, parts}` when the message
  // is durable. The resume path (HistoryClient) already gets `{info, parts}`
  // rows from the server and bypasses this entirely.
  private readonly messageInfos = new Map<string, unknown>()
  private readonly messageParts = new Map<string, Map<string, unknown>>()

  // Assistant messageIDs already committed. Guards against double-publishing
  // when late `message.updated` events touch an already-completed message
  // (usage backfill, revert flows) — and against ensureTurn() resurrecting a
  // finished turn for such stragglers. Bounded FIFO because a long-lived
  // session can produce thousands of messages.
  private readonly committedAssistant = new Set<string>()

  // Cap on how many in-flight messages we buffer parts for. 32 is generous:
  // at any moment only the live assistant message (plus the user message that
  // triggered it) is actually streaming; everything older has either been
  // committed+evicted or is stale. Without a cap an SSE stream that never
  // delivers `time.completed` (crash mid-turn) would leak part snapshots
  // forever.
  private static readonly MAX_TRACKED_MESSAGES = 32
  private static readonly MAX_COMMITTED_IDS = 256

  private sessionID: string | null

  constructor(opts: EventDispatcherOptions) {
    this.semantic = opts.semantic
    this.screen = opts.screen
    this.committed = opts.committed
    this.accumulator = opts.accumulator ?? new PartAccumulator()
    this.turns = new TurnTracker({
      semantic: opts.semantic,
      onBeforeComplete: turnId => this.closeOpenBlocksForTurn(turnId),
    })
    this.sessionID = opts.sessionID ?? null
  }

  setSessionID(sessionID: string | null): void {
    this.sessionID = sessionID
  }

  dispatch(event: OpenCodeBusEvent): void {
    const type = event.type
    const payload = payloadOf(event)

    // SESSION OWNERSHIP FILTER (2026-07-06 "agent output breaks stuff" fix).
    //
    // OpenCode's /event SSE is SERVER-WIDE: every session on the server —
    // including child sessions spawned by the agent/task tool — shares one
    // bus. This dispatcher represents exactly ONE session. Before this guard,
    // foreign-session events flowed straight through the switch below, with
    // two observed disasters (2026-07-06T16-54 debug bundle):
    //   1. A child session's messages interleaved with ours on the semantic
    //      channel — turn ids alternating A,B,A,B… 30 turn_starteds across 4
    //      messageIDs — thrashing the app's single live-turn slot into a
    //      27↔29 visible-row render spasm.
    //   2. Child-session committed messages hit the app's provider-session
    //      conflict detector (`jsonl_provider_conflict`, expected ses_X
    //      observed ses_Y), which drops the burst — so agent-tool output was
    //      lost from the durable feed entirely.
    //
    // Policy: if the event names a session and it is not OURS, drop it here.
    // Session-less events (server.*, heartbeats) pass. If we do not yet know
    // our own id (resume race before captureSessionID), we let events through
    // rather than drop legitimate early traffic — captureSessionID below only
    // ever ADOPTS an id when none is known, so the window is one event long
    // in practice (createSession sets the id before the SSE starts).
    //
    // Child-session output is intentionally DROPPED for now, not rendered:
    // surfacing subagent activity as nested rows needs its own design
    // (orchestration-style parent/child linkage), and silently merging it
    // into the parent transcript is the bug we are fixing, not a feature.
    if (this.sessionID !== null) {
      const eventSession = getString(payload, [
        'sessionID',
        'sessionId',
        'session.id',
        'info.sessionID',
        'part.sessionID',
        'message.sessionID',
      ])
      if (eventSession && eventSession !== this.sessionID) return
    }

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
      case 'session.next.agent.switched':
        this.screen.publishActivity({
          active: true,
          status: `agent:${getString(payload, ['agent']) ?? 'unknown'}`,
        })
        return
      case 'session.next.model.switched':
        this.screen.publishActivity({
          active: true,
          status: `model:${getString(payload, ['model.id', 'modelID']) ?? 'unknown'}`,
        })
        return
      case 'session.next.prompted':
      case 'session.next.synthetic':
        this.screen.publishSystem({
          category: 'command',
          action: type,
          sessionID: this.eventSessionID(payload),
          message: getString(payload, ['prompt.text', 'text']),
          metadata: payload,
        })
        return
      case 'session.next.shell.started':
      case 'session.next.shell.ended':
        this.handleNextShell(type, payload)
        return
      case 'session.next.step.started':
      case 'session.next.step.ended':
      case 'session.next.step.failed':
        this.handleNextStep(type, payload)
        return
      case 'session.next.text.started':
      case 'session.next.text.delta':
      case 'session.next.text.ended':
        this.handleNextText(type, payload)
        return
      case 'session.next.reasoning.started':
      case 'session.next.reasoning.delta':
      case 'session.next.reasoning.ended':
        this.handleNextReasoning(type, payload)
        return
      case 'session.next.tool.input.started':
      case 'session.next.tool.input.delta':
      case 'session.next.tool.input.ended':
      case 'session.next.tool.called':
      case 'session.next.tool.progress':
      case 'session.next.tool.success':
      case 'session.next.tool.failed':
        this.handleNextTool(type, payload)
        return
      case 'session.next.retried':
        this.screen.publishSystem({
          category: 'command',
          action: type,
          sessionID: this.eventSessionID(payload),
          message: getString(payload, ['error.message']),
          metadata: payload,
        })
        return
      case 'session.next.compaction.started':
      case 'session.next.compaction.delta':
      case 'session.next.compaction.ended':
        this.handleNextCompaction(type, payload)
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
      case 'question.rejected':
        this.screen.publishQuestion({ visible: false, metadata: payload })
        this.screen.publishSystem({
          category: 'command',
          action: 'question.rejected',
          sessionID: this.eventSessionID(payload),
          metadata: payload,
        })
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

      case 'session.diff':
        this.screen.publishSystem({
          category: 'project',
          action: 'session.diff',
          sessionID: this.eventSessionID(payload),
          metadata: payload,
        })
        return
      case 'file.edited':
        this.screen.publishFile({
          action: 'edited',
          sessionID: this.eventSessionID(payload),
          path: getString(payload, ['path', 'file', 'filename']),
          metadata: payload,
        })
        return
      case 'file.watcher.updated':
        this.screen.publishFile({
          action: 'watcher',
          sessionID: this.eventSessionID(payload),
          path: getString(payload, ['path', 'file', 'filename']),
          metadata: payload,
        })
        return
      case 'todo.updated':
        this.screen.publishSystem({
          category: 'command',
          action: 'todo.updated',
          sessionID: this.eventSessionID(payload),
          metadata: payload,
        })
        return
      case 'command.executed':
        this.screen.publishSystem({
          category: 'command',
          action: 'command.executed',
          sessionID: this.eventSessionID(payload),
          message: getString(payload, ['name']),
          metadata: payload,
        })
        return
      case 'vcs.branch.updated':
        this.screen.publishSystem({
          category: 'vcs',
          action: 'branch.updated',
          message: getString(payload, ['branch']),
          metadata: payload,
        })
        return
      case 'lsp.updated':
      case 'lsp.client.diagnostics':
        this.screen.publishSystem({
          category: 'lsp',
          action: type,
          message: getString(payload, ['path', 'serverID']),
          metadata: payload,
        })
        return
      case 'mcp.tools.changed':
      case 'mcp.browser.open.failed':
        this.screen.publishSystem({
          category: 'mcp',
          action: type,
          message: getString(payload, ['server', 'mcpName', 'url']),
          metadata: payload,
        })
        return
      case 'project.updated':
        this.screen.publishSystem({
          category: 'project',
          action: type,
          message: getString(payload, ['name', 'id']),
          metadata: payload,
        })
        return
      case 'workspace.ready':
      case 'workspace.failed':
      case 'workspace.status':
        this.screen.publishSystem({
          category: 'workspace',
          action: type,
          message: getString(payload, ['name', 'message', 'status', 'workspaceID']),
          metadata: payload,
        })
        return
      case 'worktree.ready':
      case 'worktree.failed':
        this.screen.publishSystem({
          category: 'worktree',
          action: type,
          message: getString(payload, ['name', 'message', 'branch']),
          metadata: payload,
        })
        return
      case 'pty.created':
      case 'pty.updated':
      case 'pty.exited':
      case 'pty.deleted':
        this.screen.publishSystem({
          category: 'pty',
          action: type,
          message: getString(payload, ['id', 'info.id', 'info.title', 'exitCode']),
          metadata: payload,
        })
        return
      case 'installation.updated':
      case 'installation.update-available':
        this.screen.publishSystem({
          category: 'installation',
          action: type,
          message: getString(payload, ['version']),
          metadata: payload,
        })
        return
      case 'catalog.model.updated':
        this.screen.publishSystem({
          category: 'catalog',
          action: type,
          metadata: payload,
        })
        return
      case 'tui.prompt.append':
      case 'tui.command.execute':
      case 'tui.toast.show':
      case 'tui.session.select':
        this.screen.publishSystem({
          category: 'tui',
          action: type,
          message: getString(payload, ['text', 'command', 'message', 'sessionID']),
          metadata: payload,
        })
        return
      case 'global.disposed':
        this.screen.publishSystem({
          category: 'global',
          action: type,
          metadata: payload,
        })
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
    // ADOPT-ONLY, never overwrite. This fallback exists for resume flows
    // where the SSE starts before the host called setSessionID. Before the
    // guard, ANY session.created/session.updated on the server-wide bus —
    // most commonly a CHILD session spawned by the agent/task tool —
    // overwrote this dispatcher's identity mid-run, silently re-pointing
    // every subsequent ownership decision (and the dispatch() filter above)
    // at the child. That identity theft was the engine behind the
    // 2026-07-06 interleaved-turn spasm.
    if (this.sessionID !== null) return
    const id = getString(payload, ['id', 'sessionID', 'session.id'])
    if (id) this.sessionID = id
  }

  private handleSessionStatus(payload: unknown): void {
    const status = getString(payload, ['status.type', 'state.type', 'session.status.type', 'status'])
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
    const info = getUnknown(payload, ['info', 'message']) ?? payload
    const messageID = getString(payload, ['info.id', 'message.id', 'id'])
    const role = getString(payload, ['info.role', 'message.role', 'role'])
    if (messageID && (role === 'user' || role === 'assistant')) {
      this.messageRoles.set(messageID, role)
      this.messageInfos.set(messageID, info)
    }

    // Committed publication policy (see the messageInfos/messageParts field
    // comment for the wire-shape evidence):
    //
    //  - user messages: publish assembled immediately. The info arrives before
    //    its parts on the bus (session.ts publishes updateMessage before
    //    updatePart for the user prompt), so this first publish may carry an
    //    empty parts array; handlePartUpdated republishes the assembled
    //    message as each user part lands, converging on the full message.
    //    User messages are tiny (1-2 parts) so the extra publish is cheap and
    //    committed consumers key on info.id.
    //
    //  - assistant messages: suppress every mid-stream republish and publish
    //    exactly ONE assembled {info, parts} when info.time.completed appears
    //    (that is OpenCode's durable-completion marker — message-v2.ts
    //    Assistant.time.completed). Mid-stream rendering is the semantic
    //    channel's job; the committed channel must only ever see durable,
    //    fully-assembled messages.
    if (messageID && role === 'assistant') {
      const completed = getUnknown(info, ['time.completed']) !== undefined
      if (!completed) {
        // The assistant message.updated is the earliest reliable turn
        // boundary on the wire (it precedes every part event), and its id is
        // the turnId every block event must share — the bundle showed tool
        // blocks keyed on sessionID targeting a phantom turn the app's fold
        // layer dropped. Guard on committedAssistant so a late touch to an
        // old message cannot resurrect a finished turn.
        if (!this.committedAssistant.has(messageID)) {
          this.turns.ensureTurn(messageID, 'assistant')
        }
      } else if (!this.committedAssistant.has(messageID)) {
        this.rememberCommitted(messageID)
        this.committed.publishMessage(sessionID, this.assembleMessage(messageID))
        this.closeOpenBlocksForTurn(messageID)
        if (this.turns.getActiveTurnId() === messageID) this.turns.completeTurn()
        this.evictMessage(messageID)
      }
    } else if (messageID && role === 'user') {
      this.committed.publishMessage(sessionID, this.assembleMessage(messageID))
    } else if (sessionID) {
      // Unknown shape (no id/role we recognize): keep the old passthrough so
      // nothing is silently dropped — downstream treats it as an opaque entry.
      this.committed.publishMessage(sessionID, payload)
    }

    // 'info.tokens' added alongside the legacy paths: the real v1 wire shape
    // is {sessionID, info} and the assistant Info carries `tokens`, so the
    // original ['usage', 'message.usage'] lookups never matched live events.
    const usage = getUnknown(payload, ['usage', 'message.usage', 'info.tokens', 'tokens'])
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
    const messageID = getString(part, ['messageID', 'messageId', 'message.id'])
    // Every semantic event for this part MUST share the messageID-derived
    // turnId. The bundle's phantom-turn failure came from mixing keys:
    // text/turn events keyed on messageID while tool/shell block events keyed
    // on sessionID, so the app's fold layer attached blocks to a turn that
    // never existed and dropped them.
    const turnId = messageID ?? this.turns.getActiveTurnId() ?? partID
    const role =
      getString(part, ['role', 'message.role']) ??
      (messageID ? this.messageRoles.get(messageID) : undefined)

    // Buffer the snapshot for committed assembly BEFORE any role gating:
    // user-message parts never reach the semantic channel but absolutely
    // belong in the durable transcript. OpenCode republishes the full part on
    // every state change (including the final text at text-end), so a plain
    // replace-by-partID map converges on the durable content. Insertion order
    // matches PartID.ascending() creation order because the first snapshot
    // for each part always precedes any other part's first snapshot.
    if (messageID) this.rememberPart(messageID, partID, part)

    const kind = normalizePartKind(getString(part, ['type', 'kind']))
    // Registered even for parts we don't stream semantically: message.part.delta
    // routing depends on this map (reasoning deltas arrive as field:"text").
    if (kind !== 'unknown') this.partKinds.set(partID, kind)

    if (role === 'user') {
      // Republish the assembled user message now that a part landed — the
      // initial message.updated publish happened before any parts existed on
      // the bus (see handleMessageUpdated).
      if (messageID) {
        this.committed.publishMessage(this.eventSessionID(payload), this.assembleMessage(messageID))
      }
      return
    }

    const text = getString(part, ['text', 'content', 'summary'])
    const name = getString(part, ['tool', 'name', 'toolName'])
    this.accumulator.applyUpdate(partID, {
      text,
      content: getString(part, ['content']),
      input: stringifyMaybe(getUnknown(part, ['input', 'args'])),
    })

    // text/reasoning parts carry time.end exactly once, on the final snapshot
    // (text-end / reasoning-end in opencode's processor) — that is our
    // block_completed signal for streaming-text blocks.
    const ended = getUnknown(part, ['time.end']) !== undefined

    if (kind === 'text' && typeof text === 'string') {
      // Snapshots carry the FULL text so far; deltas may also stream via
      // message.part.delta for the same part. __last_text_emitted is the
      // shared high-water mark between both paths so overlapping events never
      // double-append.
      const previous = this.accumulator.getField(partID, '__last_text_emitted')
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text
      this.accumulator.applyUpdate(partID, { __last_text_emitted: text })
      this.turns.ensureTurn(turnId, 'assistant')
      this.ensureBlockOpen(turnId, partID, 'text')
      if (delta) {
        // First answer-text of a turn is the 'responding' boundary; the
        // tracker dedupes so per-snapshot calls collapse to one event. The
        // bundle showed text-only turns emitting ZERO stream_phase events
        // because only thinking/tool paths ever called setPhase.
        this.turns.setPhase('responding')
        this.turns.appendText(turnId, delta)
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
      if (ended) this.closeBlock(partID)
    }

    if (kind === 'reasoning' && typeof text === 'string') {
      // Reasoning gets the same delta-dedupe as text (the old code re-emitted
      // the full accumulated reasoning as a "delta" on every snapshot) but is
      // NEVER appended to the turn's fullText — turn_delta semantics are
      // "assistant answer text only". Mixing them is exactly the corruption
      // the bundle captured.
      const previous = this.accumulator.getField(partID, '__last_thinking_emitted')
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text
      this.accumulator.applyUpdate(partID, { __last_thinking_emitted: text })
      this.turns.ensureTurn(turnId, 'assistant')
      this.ensureBlockOpen(turnId, partID, 'reasoning')
      if (delta) {
        this.turns.setPhase('thinking')
        this.semantic.publish({
          type: 'thinking_delta',
          turnId,
          blockId: partID,
          textDelta: delta,
          fullText: text,
          source: 'opencode-sse',
          ts: Date.now(),
        })
      }
      if (ended) this.closeBlock(partID)
    }

    if (kind === 'tool_use') {
      const status = getString(part, ['status', 'state.status'])
      this.turns.ensureTurn(turnId, 'assistant')
      const input = getUnknown(part, ['input', 'args', 'state.input'])
      // Gate on status: the 'pending' snapshot ships a placeholder
      // `state.input: {}` (tool-input-start in opencode's processor), and
      // publishing that as "finalized" would clobber any streamed input the
      // consumer already assembled.
      if (input !== undefined && status !== 'pending') {
        this.semantic.publish({
          type: 'tool_input_finalized',
          turnId,
          blockId: partID,
          input,
          name,
          source: 'opencode-sse',
          ts: Date.now(),
        })
      }
      // ensureBlockOpen before any completion so a tool that jumps straight
      // to completed (fast tools, replayed streams) still yields a
      // started -> completed pair; it also dedupes the old behavior of
      // re-emitting block_started on every pending/running snapshot.
      this.ensureBlockOpen(turnId, partID, 'tool_use', name)
      if (status === 'running') this.turns.setPhase('tool-use')
      const output = getTextValue(part, ['output', 'result', 'state.output', 'metadata.output'])
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
      if (status === 'completed' || status === 'error') this.closeBlock(partID)
    }
  }

  private handlePartDelta(payload: unknown): void {
    const partID = getString(payload, ['partID', 'id', 'part.id']) ?? stableID('part')
    const messageID = getString(payload, ['messageID', 'messageId', 'message.id', 'part.messageID'])
    const turnId = messageID ?? this.turns.getActiveTurnId() ?? partID
    const role =
      getString(payload, ['role', 'message.role', 'part.role']) ??
      (messageID ? this.messageRoles.get(messageID) : undefined)
    if (role === 'user') return
    const field = getString(payload, ['field']) ?? 'text'
    const delta = getString(payload, ['delta', 'text', 'content']) ?? ''
    if (!delta) return

    // WHY routing keys on the registered part kind, NOT the wire `field`:
    // OpenCode publishes reasoning deltas with `field: "text"` (processor.ts
    // `reasoning-delta`), indistinguishable from answer-text deltas at the
    // field level. Routing by field was the bundle's smoking gun — 199 flat
    // turn_delta events with reasoning concatenated into the answer. The
    // part's `message.part.updated` snapshot (which always precedes deltas)
    // told us the real kind via partKinds; the field is only a fallback for
    // parts whose snapshot we never saw (SSE reconnect mid-part).
    const kind = this.partKinds.get(partID) ?? kindFromDeltaField(field)
    const full = this.accumulator.applyDelta(partID, field, delta)

    if (kind === 'reasoning') {
      // Keep the snapshot path's high-water mark in sync so the final
      // part.updated (full reasoning text) does not re-emit everything.
      this.accumulator.applyUpdate(partID, { __last_thinking_emitted: full })
      this.turns.ensureTurn(turnId, 'assistant')
      this.ensureBlockOpen(turnId, partID, 'reasoning')
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

    if (kind === 'text') {
      this.accumulator.applyUpdate(partID, { __last_text_emitted: full })
      this.turns.ensureTurn(turnId, 'assistant')
      this.ensureBlockOpen(turnId, partID, 'text')
      this.turns.setPhase('responding')
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

    this.turns.ensureTurn(turnId, 'assistant')
    this.ensureBlockOpen(turnId, partID, 'tool_use')
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

  private handleNextShell(type: string, payload: unknown): void {
    const sessionID = this.eventSessionID(payload)
    // WHY not sessionID as turnId: session.next.* events genuinely carry no
    // messageID (v2/session-event.ts — Base is {timestamp, sessionID} plus
    // callID/command), but the rest of the turn's events key on the assistant
    // messageID. Keying these on sessionID made every shell block target a
    // phantom turn that the app's fold layer dropped (bundle evidence: zero
    // renderable block events). The tracker's active turn IS the assistant
    // messageID whenever a turn is live, so derive from it.
    const turnId = this.nextTurnId(payload)
    const blockId = getString(payload, ['callID']) ?? stableID('shell')
    if (type.endsWith('.ended')) {
      // Open-before-close: if we never saw .started (attach mid-run), emit
      // the started half so downstream folding sees a complete pair.
      this.ensureBlockOpen(turnId, blockId, 'tool_use', 'shell')
      this.semantic.publish({
        type: 'tool_result',
        turnId,
        toolUseId: blockId,
        name: 'shell',
        content: getString(payload, ['output']) ?? '',
        isError: false,
        source: 'opencode-sse',
        ts: Date.now(),
      })
      this.closeBlock(blockId)
    } else {
      this.ensureBlockOpen(turnId, blockId, 'tool_use', 'shell')
    }
    this.screen.publishSystem({
      category: 'command',
      action: type,
      sessionID,
      message: getString(payload, ['command', 'output']),
      metadata: payload,
    })
  }

  private handleNextStep(type: string, payload: unknown): void {
    const usage = getUnknown(payload, ['tokens'])
    if (usage) {
      this.semantic.publish({
        type: 'usage_updated',
        turnId: this.turns.getActiveTurnId(),
        usage,
        source: 'opencode-sse',
        ts: Date.now(),
      })
    }
    this.screen.publishSystem({
      category: 'command',
      action: type,
      sessionID: this.eventSessionID(payload),
      message: getString(payload, ['finish', 'error.message', 'agent']),
      metadata: payload,
    })
  }

  private handleNextText(type: string, payload: unknown): void {
    // turnId derives from the active turn (see handleNextShell comment for
    // the phantom-turn evidence); the blockId stays keyed on sessionID so the
    // accumulator/fold key is stable across the whole stream even if the
    // active turn flips between .started and .delta.
    const turnId = this.nextTurnId(payload)
    const blockId = `${this.eventSessionID(payload)}:next-text`
    if (type.endsWith('.started')) {
      this.ensureBlockOpen(turnId, blockId, 'text')
      return
    }
    const delta = getString(payload, ['delta', 'text']) ?? ''
    const full = type.endsWith('.ended') ? delta : this.accumulator.applyDelta(blockId, 'text', delta)
    if (delta) {
      this.ensureBlockOpen(turnId, blockId, 'text')
      this.turns.setPhase('responding')
      this.semantic.publish({
        type: 'text_delta',
        turnId,
        blockId,
        textDelta: delta,
        fullText: full,
        source: 'opencode-sse',
        ts: Date.now(),
      })
    }
    if (type.endsWith('.ended')) this.closeBlock(blockId)
  }

  private handleNextReasoning(type: string, payload: unknown): void {
    const turnId = this.nextTurnId(payload)
    const blockId =
      getString(payload, ['reasoningID']) ?? `${this.eventSessionID(payload)}:next-reasoning`
    if (type.endsWith('.started')) {
      this.ensureBlockOpen(turnId, blockId, 'reasoning')
      return
    }
    const delta = getString(payload, ['delta', 'text']) ?? ''
    const full = type.endsWith('.ended') ? delta : this.accumulator.applyDelta(blockId, 'text', delta)
    if (delta) {
      this.ensureBlockOpen(turnId, blockId, 'reasoning')
      this.turns.setPhase('thinking')
      this.semantic.publish({
        type: 'thinking_delta',
        turnId,
        blockId,
        textDelta: delta,
        fullText: full,
        source: 'opencode-sse',
        ts: Date.now(),
      })
    }
    if (type.endsWith('.ended')) this.closeBlock(blockId)
  }

  private handleNextTool(type: string, payload: unknown): void {
    const turnId = this.nextTurnId(payload)
    const blockId = getString(payload, ['callID']) ?? stableID('tool')
    const name = getString(payload, ['name', 'tool'])
    if (type.endsWith('.input.started') || type.endsWith('.called')) {
      // ensureBlockOpen dedupes the old double block_started that fired for
      // both .input.started and .called on the same callID.
      this.ensureBlockOpen(turnId, blockId, 'tool_use', name)
    }
    if (type.endsWith('.input.delta')) {
      const delta = getString(payload, ['delta']) ?? ''
      const full = this.accumulator.applyDelta(blockId, 'input', delta)
      this.ensureBlockOpen(turnId, blockId, 'tool_use', name)
      this.turns.setPhase('tool-input')
      this.semantic.publish({
        type: 'tool_input_delta',
        turnId,
        blockId,
        inputDelta: delta,
        fullInput: full,
        name,
        source: 'opencode-sse',
        ts: Date.now(),
      })
      return
    }
    const input = getUnknown(payload, ['input'])
    if (type.endsWith('.called') && input !== undefined) {
      this.semantic.publish({
        type: 'tool_input_finalized',
        turnId,
        blockId,
        input,
        name,
        source: 'opencode-sse',
        ts: Date.now(),
      })
    }
    if (type.endsWith('.success') || type.endsWith('.failed') || type.endsWith('.progress')) {
      const content = getTextValue(payload, ['content', 'structured', 'error.message']) ?? ''
      this.ensureBlockOpen(turnId, blockId, 'tool_use', name)
      this.semantic.publish({
        type: 'tool_result',
        turnId,
        toolUseId: blockId,
        name,
        content,
        isError: type.endsWith('.failed'),
        source: 'opencode-sse',
        ts: Date.now(),
      })
    }
    if (type.endsWith('.success') || type.endsWith('.failed')) this.closeBlock(blockId)
  }

  private handleNextCompaction(type: string, payload: unknown): void {
    this.screen.publishCompaction({
      active: !type.endsWith('.ended'),
      sessionID: this.eventSessionID(payload),
      metadata: payload,
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

  // turnId for session.next.* events, which carry no messageID on the wire.
  // Prefer the tracker's active turn (the assistant messageID established by
  // message.updated / message.part.* events) so every block of a turn shares
  // one key; fall back to sessionID only when nothing has opened a turn yet —
  // in that case there is no better identity available and downstream will at
  // least group the events consistently with each other.
  private nextTurnId(payload: unknown): string {
    return this.turns.getActiveTurnId() ?? this.eventSessionID(payload)
  }

  private ensureBlockOpen(
    turnId: string,
    blockId: string,
    kind: SemanticBlockKind,
    name?: string,
  ): void {
    if (this.openBlocks.has(blockId)) return
    this.openBlocks.set(blockId, { turnId, kind, name })
    this.semantic.publish({
      type: 'block_started',
      turnId,
      blockId,
      kind,
      name,
      source: 'opencode-sse',
      ts: Date.now(),
    })
  }

  private closeBlock(blockId: string): void {
    const block = this.openBlocks.get(blockId)
    if (!block) return
    this.openBlocks.delete(blockId)
    this.semantic.publish({
      type: 'block_completed',
      turnId: block.turnId,
      blockId,
      kind: block.kind,
      name: block.name,
      source: 'opencode-sse',
      ts: Date.now(),
    })
  }

  // Invoked by TurnTracker (onBeforeComplete) and by the assistant-completed
  // path so that no turn ever finishes with dangling open blocks — a
  // block_started without a matching block_completed leaves the app's fold
  // layer holding a permanently "streaming" block.
  private closeOpenBlocksForTurn(turnId: string): void {
    for (const [blockId, block] of [...this.openBlocks]) {
      if (block.turnId === turnId) this.closeBlock(blockId)
    }
  }

  private rememberPart(messageID: string, partID: string, part: unknown): void {
    let parts = this.messageParts.get(messageID)
    if (!parts) {
      parts = new Map()
      this.messageParts.set(messageID, parts)
      // FIFO eviction: Map iteration order is insertion order, so the first
      // key is always the oldest tracked message. See MAX_TRACKED_MESSAGES
      // for why a cap exists at all.
      while (this.messageParts.size > EventDispatcher.MAX_TRACKED_MESSAGES) {
        const oldest = this.messageParts.keys().next().value
        if (oldest === undefined) break
        this.evictMessage(oldest)
      }
    }
    parts.set(partID, part)
  }

  private rememberCommitted(messageID: string): void {
    this.committedAssistant.add(messageID)
    while (this.committedAssistant.size > EventDispatcher.MAX_COMMITTED_IDS) {
      const oldest = this.committedAssistant.values().next().value
      if (oldest === undefined) break
      this.committedAssistant.delete(oldest)
    }
  }

  private evictMessage(messageID: string): void {
    const parts = this.messageParts.get(messageID)
    if (parts) {
      for (const partID of parts.keys()) {
        this.partKinds.delete(partID)
        this.openBlocks.delete(partID)
        this.accumulator.evict(partID)
      }
    }
    this.messageParts.delete(messageID)
    this.messageInfos.delete(messageID)
  }

  // The `{info, parts}` shape mirrors what the server's message-list endpoint
  // returns (message-v2.ts WithParts) and what HistoryClient replays on
  // resume, so committed consumers see one shape regardless of whether a
  // message arrived live or from history. The info fallback covers the
  // pathological ordering where a part somehow precedes its message.updated —
  // downstream then still gets an entry keyed by id instead of nothing.
  private assembleMessage(messageID: string): { info: unknown; parts: unknown[] } {
    const info = this.messageInfos.get(messageID) ?? { id: messageID }
    const parts = this.messageParts.get(messageID)
    return { info, parts: parts ? [...parts.values()] : [] }
  }
}

function payloadOf(event: OpenCodeBusEvent): unknown {
  return event.properties ?? event.payload ?? event
}

function normalizePartKind(kind: string | undefined): SemanticBlockKind {
  if (!kind) return 'unknown'
  if (kind === 'text' || kind === 'assistant_text') return 'text'
  if (kind === 'reasoning' || kind === 'thinking') return 'reasoning'
  // Normalized to 'tool_use' — the renderer's tool-row vocabulary — not the
  // wire's 'tool'. See the SemanticBlockKind comment in channels/types.ts.
  if (kind === 'tool' || kind === 'tool-call' || kind === 'tool_use') return 'tool_use'
  return 'unknown'
}

// Fallback routing for message.part.delta when the part's snapshot (and thus
// its registered kind) was never seen — e.g. an SSE reconnect landing mid-part.
// Mirrors the pre-fix field heuristic: text-ish fields stream as answer text,
// explicit thinking fields as reasoning, anything else as tool input. Note
// this CANNOT distinguish a reasoning delta (field:"text" on the wire) from an
// answer delta — only partKinds can — which is exactly why it is a fallback.
function kindFromDeltaField(field: string): 'text' | 'reasoning' | 'tool' {
  if (field === 'text' || field === 'content') return 'text'
  if (field === 'thinking' || field === 'reasoning') return 'reasoning'
  return 'tool'
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

function getTextValue(value: unknown, paths: string[]): string | undefined {
  const found = getUnknown(value, paths)
  if (typeof found === 'string') return found
  if (found === undefined || found === null) return undefined
  return JSON.stringify(found)
}

function stringifyMaybe(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return undefined
  return JSON.stringify(value)
}

function stableID(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
