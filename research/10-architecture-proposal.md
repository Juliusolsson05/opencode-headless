# 10 — Architecture proposal for `opencode-headless`

> **Status:** synthesis of research agents 01–09. The implementation
> session reads this doc and writes code from it. Anything missing here
> the next session has to re-derive from scratch — so this is written
> long on purpose. No length cap.

---

## 1. Verdict and thesis

`opencode-headless` is an **SDK-on-top transport adapter**. It spawns
`opencode serve` (or attaches to a remote one), opens one SSE stream at
`GET /event`, projects the **72 typed bus events** into the existing
three-channel surface (`SemanticChannel` | `ScreenChannel` |
`CommittedChannel`), and gates approvals via one structured event +
one POST. It is **decisively the smallest of the three headless
packages**: no PTY, no `@xterm/headless` wrapper, no mitmproxy, no SSE
framer, no per-provider parser, no screen parser, no live-owner state
machine, no conditions framework, no JSONL tailer, no project-dir
walker.

Why each "no" holds, anchored to the prior research:

| "No" | Evidence | Reference |
|---|---|---|
| No PTY | `opencode serve` is a documented first-class headless mode that prints `opencode server listening on http://…`; the official SDK consumes it via `cross-spawn` + listen-line parse (`packages/sdk/js/src/v2/server.ts:22-100`) | `research/01-process-and-cli.md` §"SDK already does the spawn dance" |
| No mitmproxy | The server *is* the fan-out. `/event` SSE is a flat firehose of `Bus.subscribeAll()` (`server/event.ts:39-87`); zero provider-tap is needed | `research/02-server-and-wire-protocol.md` §"Punchline"; `research/04-sdk-vs-tui-gap.md` §"Architecture observation" |
| No screen parser | OpenCode's TUI is OpenTUI + SolidJS buffer-mode rendering and is itself just a remote-attachable SDK client (`cli/cmd/tui/attach.ts:10-48`, `cli/cmd/tui/context/sdk.tsx:1-80`). There is no TUI-only signal to recover | `research/07-tui-and-screen-surface.md`; `research/04-sdk-vs-tui-gap.md` |
| No per-provider parser | All Anthropic / OpenAI / Bedrock / Gemini / OpenRouter / Groq / Copilot wire decoding is delegated to the Vercel AI SDK and consumed as a unified `LLM.Event` vocabulary in one 17-case switch (`session/processor.ts:220`) — re-emitted to the bus, not parsed by us | `research/05-provider-abstraction.md` §"TL;DR" |
| No live-owner state machine | OpenCode has one live source (the bus) and no proxy-vs-jsonl-vs-screen race to mediate. `liveOwner` collapses to a constant `kind:"server"` | `research/04-sdk-vs-tui-gap.md` §"What this means for the channel model"; `research/02-server-and-wire-protocol.md` §"Live-owner state machine" cell |
| No conditions framework | Approvals are structured: `permission.asked` SSE event → `POST /permission/{id}/reply { reply: "once"\|"always"\|"reject", message? }`. The TUI itself calls `sdk.client.permission.reply(...)` (`cli/cmd/tui/routes/session/permission.tsx:190,201,440,447`). One typed event + one POST replaces both `packages/claude-code-headless/src/parsers/PermissionPromptParser.ts` AND `packages/codex-headless/src/conditions/` in its entirety | `research/08-approval-and-permissions.md` §"Punchline" |
| No JSONL tailer | Persistence is SQLite (Drizzle/`bun:sqlite`, WAL) at `${XDG_DATA_HOME}/opencode/opencode.db`. Durable history is fetched via `GET /session/{id}/message` (cold snapshot) and `POST /sync/history` (replay-from-offset). No file to tail. | `research/06-session-persistence-and-resume.md` §"On-disk layout", §"Reattach contract" |
| No project-dir walker | Project key is the **first-parent commit SHA** (`git rev-list --max-parents=0 HEAD`), not a sanitized cwd hash (Claude) or a date bucket (Codex). Derivation is one shell-out, no walk. | `research/06-session-persistence-and-resume.md` §"Schema" |

The thesis the manifesto warned about — "if you strip things down to
send-message-get-message-back, you lose most of what makes those tools
good" — is the wrong test for OpenCode because **the SDK is not a
reduction of the TUI**. The TUI is a reduction of the SDK. There is no
private channel from the agent runtime to the TUI; everything flows over
the bus. Wrapping the TUI would add an IPC layer and zero additional
signal. (`research/04-sdk-vs-tui-gap.md` §"Architecture observation
that reframes the question".)

---

## 2. Side-by-side architecture comparison

> Rows are subsystems. Cells say what each package does, with file:line
> references where applicable. "n/a" means the subsystem exists in the
> column above but is structurally absent for this provider.

| Subsystem | `claude-code-headless` | `codex-headless` | `opencode-headless` (proposed) |
|---|---|---|---|
| Process model | Consumer-owned `IPty` to the `claude` TUI. Constructor takes `pty: IPty`. (`src/ClaudeCodeHeadless.ts`) | Same — consumer-owned `IPty` to `codex` TUI. (`src/CodexHeadless.ts`) | **Library-owned `child_process` running `opencode serve`** (auto-spawn) *or* attach to a `serverUrl` the caller supplies. No PTY in either case. Spawn dance reuses `@opencode-ai/sdk/v2`'s `createOpencodeServer` (`packages/sdk/js/src/v2/server.ts:22-100`) — at minimum copy the 80-line shape, ideally depend on the SDK. |
| Terminal layer | `src/terminal/HeadlessTerminal.ts` wraps `@xterm/headless` + node-pty. Plain + markdown + recent snapshots. ~451 LOC. | Same file, byte-identical wrapper imported. | **None.** `terminal/` directory does not exist. There is no PTY to mirror. |
| Screen parsers | `src/parsers/{ScreenParser,TrustDialogParser,PermissionPromptParser,CompactionParser,ResumePromptParser,SlashPickerParser,LineDiff}.ts` (7 files, hundreds of LOC) | `src/parsers/{ScreenParser,ApprovalParser,TrustDialogParser,LineDiff}.ts` (4 files) plus `src/conditions/` for approval+trust → action mapping | **None.** OpenCode's TUI is OpenTUI + SolidJS buffer-mode (`research/07-tui-and-screen-surface.md`). Zero parser files. |
| Proxy / wire framing | `src/proxy/{ClaudeProxyAdapter,anthropicEvents,sseFraming}.ts`. mitmproxy + Anthropic SSE parser + sidecar attribution. ~900+ LOC. | `src/proxy/{CodexResponsesAdapter,responsesProxy}.ts`. Plain-HTTP proxy on 127.0.0.1 + OpenAI Responses-API parser. ~1100+ LOC. | **None.** OpenCode is its own server; consume `GET /event` SSE directly. The Vercel AI SDK already normalizes provider wire formats inside the OpenCode server (`research/05-provider-abstraction.md`). |
| Provider awareness | Single provider (Anthropic). Sidecar detection (`isSidecarFlow`) classifies Haiku title-gen, compaction summaries, hook agents. | Single provider (OpenAI Responses API). Flow attribution state machine (`candidate \| active \| secondary \| ignore`). | **Provider-agnostic.** All ~20 providers (`anthropic`, `openai`, `bedrock`, `gemini`, `google-vertex`, `openrouter`, `groq`, `xai`, `mistral`, `cohere`, `cerebras`, `deepinfra`, `togetherai`, `perplexity`, `vercel`, `gateway`, `gitlab`, `github-copilot`, `venice`, `opencode`) are handled inside the OpenCode server. We do not see raw provider frames. |
| Live semantic source | `proxy` (mitmproxy SSE) → high; `screen` → fallback; `jsonl` → medium (committed). | `proxy` (Responses) → high; `rollout` JSONL (live) → high; `screen` → fallback. | **`server`** (single value). `/event` SSE is authoritative. `screen` enum value is retained in `SemanticSource` for cross-package type symmetry but never emitted. |
| `SemanticChannel` | 21 event types incl. `block_started`, `text_delta`, `thinking_delta`, `signature`, `tool_input_delta`, `tool_input_finalized`, `block_completed`, `tool_result`, `turn_stopped`, `usage_updated`, `stream_error`, `api_error`, `flow_selected`, `flow_ignored`, `stream_phase`, `lifecycle_violation`. (`src/channels/types.ts:709-731`) | Same 21 event types, same shape. | **Same 21 event types** (subset and superset of OpenCode's vocab — see §5). Some events are unreachable (`signature`, `citations_delta` — Anthropic-specific, folded into `providerMetadata` by the AI SDK and not streamed; `flow_selected`/`flow_ignored` — only one flow ever). Type kept identical for symmetry; the dispatcher just never emits the unreachable variants for OpenCode. |
| `ScreenChannel` | Active. Emits `snapshot`, `activity`, `trust_dialog`, `resume_prompt`, `compaction`, `slash_picker`. (`src/channels/types.ts:742-789`) | Active. Same shape; `trust_dialog`, `approval` (different from Claude's permission), `activity`. | **Effectively no-op** for the wrapped server. The class exists for caller-channel-symmetry (downstream IDE code switches on channel kind) and may emit synthetic events for things like `activity` derived from the active assistant message — see §3 and §5. Do NOT delete the class; delete the parser-fed events. |
| `CommittedChannel` | Active. Emits `turn_committed`, `entry`, `compact_boundary`, `tool_result`. Fed by JSONL tailer. (`src/channels/types.ts:800-870`) | Active. Same vocabulary. Fed by rollout tailer. | Active. Fed by `GET /session/{id}/message` (cold snapshot) and `POST /sync/history` (incremental). Maps OpenCode's `Message`+`Part` rows into the same event surface. See §5 and §8. |
| Live-owner state machine | `LiveOwnerKind = 'proxy' \| 'screen'` (jsonl deliberately excluded — it's durable). 3 sources, with a `semanticShadow` channel in Codex. Full transitions in `LiveOwnerState`/`LiveOwnerDecision` (`src/channels/types.ts:98-139`). | Same. Three sources (proxy / rollout / screen) with explicit `transitionLiveOwner` calls. | **Collapses to a constant.** One source (`server`), one owner. The state machine is not deleted (cross-package consistency) but `claim`/`transition`/`clear` are trivial pass-throughs that always accept the server's claim. No `screen` claim ever fires. |
| Conditions framework | n/a | `src/conditions/{evaluateCodexConditions,approval,trustDialog,types,index}.ts`. Pure-function condition evaluator synthesizing TUI screen + rollout metadata into typed `ConditionPtyAction \| ConditionCustomAction`. | **None.** `permission.asked` event already carries everything (tool name, patterns, metadata, message+call IDs). Reply is one typed REST call. No keystroke synthesis. |
| Transcript storage | JSONL files at `~/.claude/projects/<sanitized-cwd>/<sid>.jsonl`. Per-cwd. | JSONL files at `~/.codex/sessions/YYYY/MM/DD/rollout-…jsonl`. Date-bucketed global. | **SQLite** at `${XDG_DATA_HOME}/opencode/opencode.db` (Drizzle/`bun:sqlite`, WAL, FK on). Project key = first-parent git SHA. (`research/06` §"On-disk layout") |
| Transcript tailer | `src/transcript/JsonlTailer.ts` — `fs.watchFile` poll at 100ms, partial-line buffering, bootstrap-from-tail. | Same file, same design. | **None.** No file to tail. Instead a `HistoryClient` wraps `GET /session/{id}/message` (cold) + `POST /sync/history { aggregateID, lastSeq }` (incremental, gated on `OPENCODE_EXPERIMENTAL_WORKSPACES` — see §13). |
| Project-dir resolution | `src/transcript/ProjectDir.ts` — sanitize cwd, hash if long. | Same shape. | `src/transcript/ProjectKey.ts` — derive first-parent git SHA via `git rev-list --max-parents=0 HEAD` from the workspace directory. The same project key the server uses (`packages/opencode/src/project/project.ts:248`). |
| Session list | `src/transcript/SessionList.ts` — enumerate `*.jsonl` in project dir, parse first lines for metadata. | Walk the date tree, read up to 80 lines for cwd filter. | `src/transcript/SessionList.ts` — wrap `sdk.session.list({ directory })` (v1) or `sdk.session.list({ workspaceID })` (v2). Pure HTTP. |
| Sidecar / aux-call filtering | Yes (Haiku title-gen, compaction, hook agents detected by request shape). | Yes (Responses flow attribution). | **None needed.** The OpenCode server attributes its own calls; the bus only emits user-visible turns. Anything internal (compaction summaries, autocompact, retry) surfaces as first-class typed events (`session.next.compaction.*`, `session.next.retried`). |
| Public class shape | `class ClaudeCodeHeadless extends EventEmitter` — ~1384 LOC. Constructor `{ pty, cwd, cols, rows, snapshotIntervalMs, resumeSessionId?, proxy? }`. | `class CodexHeadless extends EventEmitter` — comparable size. Constructor `{ pty, cwd, cols?, rows?, resumeThreadId? }`. | `class OpencodeHeadless extends EventEmitter` — ~600–800 LOC target. Constructor `{ spawn?, serverUrl?, cwd, password?, sessionID?, signal? }` (`spawn` and `serverUrl` mutually exclusive). See §4. |
| Package size estimate | ~2500 LOC + tests | ~2500 LOC + tests | ~600–900 LOC + tests. Mostly: dispatcher switch, part accumulator, channel projection, permission glue, history client, reattach driver. |
| Docs alongside | `EVENT_SPEC.md` (Anthropic SSE vocabulary, 232 lines), `PROXY_STREAMING.md` (mitmproxy architecture, 816 lines). | n/a (vocabulary lives in source comments). | `EVENT_SPEC.md` equivalent (the 72 bus events + the projection table — basically §5 of this doc, lifted into its own file). `PROXY_STREAMING.md` is **N/A** for OpenCode — say so explicitly with a one-line `PROXY_STREAMING.md` stub redirecting to `EVENT_SPEC.md` so future-you doesn't go looking. |

---

## 3. Proposed `src/` directory layout — file by file

Every file lists: WHY (the thick comment the implementation must include
per `CLAUDE.md`), public exports, intra-package dependencies, analog in
the existing two packages, rough LOC.

### `src/index.ts`

**WHY**: barrel export of the public surface so consumers can do
`import { OpencodeHeadless, SemanticChannel, … } from 'opencode-headless'`
without depending on internal paths. Re-export the three channel
classes, the public types, and the main class.

**Exports**: `OpencodeHeadless`, `OpencodeHeadlessOptions`,
`SemanticChannel`, `ScreenChannel`, `CommittedChannel`, plus types
re-exported from `channels/types.ts` (`SemanticEvent`, `ScreenEvent`,
`CommittedEvent`, `SemanticSource`, `SemanticConfidence`,
`LiveOwnerState`), plus permission types from
`permissions/PermissionService.ts`, plus transcript types from
`transcript/TranscriptTypes.ts`.

**Deps**: every other file in the package.

**Analog**: `packages/claude-code-headless/src/index.ts`,
`packages/codex-headless/src/index.ts`. ~30 LOC.

---

### `src/OpencodeHeadless.ts`

**WHY**: the orchestrator. Owns the spawned server (if we spawned it),
the `SseClient`, the `EventDispatcher`, the three channels, the
`PermissionService`, and the `HistoryClient`. Replaces the
~1384-LOC `ClaudeCodeHeadless.ts` but is much smaller because it has
nothing to arbitrate — no live-owner state machine to drive, no PTY to
mirror, no proxy-vs-jsonl reconciliation. Constructor is inert; real
work begins on `start()`.

**Exports**: `class OpencodeHeadless extends EventEmitter`, the
`OpencodeHeadlessOptions` interface.

**Methods** (see §4 for full signatures):
- `start(): Promise<void>` — spawn server if needed, open SSE, create
  or resume session, prime the dispatcher.
- `stop(): Promise<void>` — close SSE, dispose instance, kill spawned
  server, flush part accumulator.
- `sendPrompt(text, opts?): Promise<{ messageID }>` — `POST
  /session/{id}/prompt` (v2) or `POST /session/{id}/message` (v1) per
  configured surface.
- `abort(): Promise<void>` — `POST /session/{id}/abort`.
- `replyToPermission(requestID, reply, message?): Promise<void>` —
  pass-through to `PermissionService.reply`.
- `isIdle()`, `isWorking()` — derived from last `session.status`.
- `getActivity()`, `getApprovalState()`, `getCompactionState()` —
  derived state queries.
- `getSemanticChannel() / getScreenChannel() / getCommittedChannel()` —
  channel accessors for typed subscribe.
- Legacy flat events for back-compat: `event`, `idle`, `activity`,
  `exit`, `error`.

**Deps**: every other file.

**Analog**: `ClaudeCodeHeadless`, `CodexHeadless`. **~400–600 LOC.**

---

### `src/transport/SpawnedServer.ts`

**WHY**: the spawn dance. Encapsulates `cross-spawn("opencode", ["serve",
"--hostname=…", "--port=…"])`, parses `opencode server listening on
<url>` off stdout (`packages/sdk/js/src/v2/server.ts:51-69`), exposes
`{ url, password, close() }`. Honors `OPENCODE_CONFIG_CONTENT` env so
config can be injected without writing a tempdir. Sets
`OPENCODE_SERVER_PASSWORD` if the caller didn't supply one (random 32
bytes hex). Forwards stderr to a logger.

**Why not just depend on `@opencode-ai/sdk`?** Open question — see
§13. The pragmatic answer: depend on it for v1, vendor the 80 lines if
the SDK becomes a footgun.

**Exports**: `class SpawnedServer { url, password, close() }`,
`spawnOpencodeServer(opts): Promise<SpawnedServer>`.

**Deps**: `node:child_process` (or `cross-spawn`), `node:crypto`.

**Analog**: nothing — neither existing package spawns a process. ~80–120 LOC.

---

### `src/transport/SseClient.ts`

**WHY**: long-lived SSE consumer of `GET /event`. Handles the
fundamentals: `Accept: text/event-stream`, `Authorization: Basic …`,
`x-opencode-directory: <abs cwd>` header, the 10s `server.heartbeat`
keepalive (`server/event.ts:52-60`), reconnect with exponential
backoff. Does NOT do replay — that's `HistoryClient`'s job because the
SSE endpoint has no `Last-Event-ID` (research/02 gap). When the
connection drops, the dispatcher gets a synthetic `transport.disconnected`
followed by `transport.reconnected` once we resume; the reattach
driver in `OpencodeHeadless.start()` then re-syncs via `POST
/sync/history` (see §6).

**Exports**: `class SseClient extends EventEmitter` with events `event`
(typed payload), `disconnect`, `reconnect`, `error`; methods
`connect()`, `disconnect()`.

**Deps**: `node:undici` (for `EventSource`-like fetch streaming) or a
small hand-rolled SSE parser modeled on
`packages/claude-code-headless/src/proxy/sseFraming.ts:IncrementalSseParser`.

**Analog**: structurally close to `IncrementalSseParser` but consumer-side
(claude's framer was inside the proxy adapter). ~150–250 LOC.

---

### `src/transport/SyncClient.ts`

**WHY**: typed REST wrapper for the small set of endpoints we hit:
`POST /session`, `POST /session/{id}/prompt[_async]`, `POST
/session/{id}/abort`, `GET /session/{id}/message`, `POST /sync/history`,
`POST /permission/{id}/reply`, `DELETE /instance`. Either thin wrapper
around `@opencode-ai/sdk/v2`'s generated client (`createOpencodeClient`
+ `OpencodeClient`) or hand-rolled `fetch` for the 7 endpoints —
implementer's call (see §13).

**Exports**: `class SyncClient { session, permission, sync, instance }`
matching the SDK's namespace shape so a future SDK-bump migration is
mechanical.

**Deps**: `@opencode-ai/sdk/v2` (preferred) or `node:undici`.

**Analog**: none — Claude/Codex don't have HTTP REST surfaces. ~100–200 LOC,
mostly with the SDK; ~300+ if hand-rolled.

---

### `src/dispatcher/EventDispatcher.ts`

**WHY**: **this is the package.** A single `switch` over the 72-variant
`Event` union from `@opencode-ai/sdk/v2` (or its successor). Each case
maps the bus event to a typed channel emission. The mapping table is
§5. The dispatcher is pure — no I/O, no state beyond the `partAccumulator`
it owns — and is the only file that knows about OpenCode's event
vocabulary.

The thick WHY-comment at the top should reproduce §5's mapping table so
the engineer adding a new event variant has the rule in front of them.

**Exports**: `class EventDispatcher { constructor(opts: { semantic,
screen, committed, accumulator }); dispatch(evt: Event): void }`.

**Deps**: `channels/`, `dispatcher/partAccumulator.ts`,
`dispatcher/turnTracker.ts`.

**Analog**: `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts`
in spirit (one event-vocabulary switch), but ~10× shorter because we
don't parse SSE, attribute flows, or detect sidecars. ~300–500 LOC,
dominated by the switch arms.

---

### `src/dispatcher/partAccumulator.ts`

**WHY**: OpenCode's hybrid live/lazy model means `message.part.delta`
events are **bus-only and never persisted**
(`research/06-session-persistence-and-resume.md` §"Live-vs-lazy" —
`session/processor.ts:538-544` calls `Bus.publish(PartDelta, ...)` with
no projector). If the SSE connection drops mid-text and we reconnect
via `POST /sync/history`, the deltas we missed are *gone* — the server
only stored the empty placeholder at `text-start` and will store the
final assembled text at `text-end`. To survive a mid-stream
disconnect, the client must buffer deltas in memory keyed by `partID`
and reconcile against the eventual `text-end`-driven `PartUpdated`.

This file owns that in-memory ring. Buffer ceiling is a tunable
(default: 1 MiB per part, 64 active parts; eviction policy: LRU once
the limit is hit, with a soft warning event so consumers can show
"partial text may be truncated").

**Exports**: `class PartAccumulator { applyDelta(partID, field,
delta); applyUpdate(partID, finalPart); getPart(partID): Part \|
undefined; evict(partID); evictAll(); on('overflow', cb) }`.

**Deps**: none (pure data structure).

**Analog**: none in existing packages — Claude's mitmproxy delivers a
continuous SSE stream so the consumer never has to buffer across a
disconnect, and Codex's rollout writes deltas immediately to disk. ~150–200 LOC.

---

### `src/dispatcher/turnTracker.ts`

**WHY**: derives `SemanticChannel` turn lifecycle (`turn_started` /
`turn_delta` / `turn_completed`) from OpenCode's per-step events,
because OpenCode's bus does **not** emit a single "turn" — it emits
`session.next.step.{started,ended,failed}` per LLM call and
`session.status` for the overall turn. The tracker maintains
`{ activeTurnID, activeMessageID, activeStepID }` and decides when to
open/close a turn on the SemanticChannel. Also derives `stream_phase`
(`thinking` / `responding` / `tool-input` / `awaiting-tool` / `idle`)
from the per-block events for parity with Claude's `streamMode`.

**Exports**: `class TurnTracker { onStepStarted, onStepEnded,
onTextStarted, onTextDelta, onTextEnded, onReasoning…, onTool…,
onSessionStatus; getActiveTurnId(): string \| null; getStreamPhase():
StreamPhase }`.

**Deps**: `channels/SemanticChannel.ts`, `channels/types.ts`.

**Analog**: closest to the live-owner state machine in
`ClaudeCodeHeadless` but reduced to "turn boundary detector" because
ownership is trivial. ~150–250 LOC.

---

### `src/channels/types.ts`

**WHY**: shared types. Re-exports the channel-event union types from
the existing packages **verbatim** (`SemanticEvent`, `ScreenEvent`,
`CommittedEvent`, `SemanticSource`, `SemanticConfidence`,
`LiveOwnerState`, `LiveOwnerDecision`, `StreamPhase`, the per-event
variant interfaces) plus any OpenCode-specific additions (currently
none — see §13 on whether we need `auth_required` for MCP
`needs_auth`).

**Critical decision**: do we vendor a copy of the union, or import
from `claude-code-headless`? Import — having three packages with
drifting type definitions is the failure mode. The implementation
session should extract `channels/types.ts` from `claude-code-headless`
into a shared `packages/headless-shared/` and have all three packages
depend on it. **Defer that refactor** to a follow-up PR; for now,
duplicate the file and add a top-comment marking the canonical source.

**Exports**: same union surface as
`packages/claude-code-headless/src/channels/types.ts`.

**Deps**: none (types only).

**Analog**: identical to existing packages by design. ~870 LOC if
duplicated, or 1 line of re-export once the shared package exists.

---

### `src/channels/SemanticChannel.ts`

**WHY**: the strict-lifecycle semantic channel. Same class signature
as `packages/claude-code-headless/src/channels/SemanticChannel.ts` and
`packages/codex-headless/src/channels/SemanticChannel.ts` — start /
delta / finish / publishX / on / off. Strict mode (no auto-heal) per
the 2026-04-18 redesign that the existing packages already use; a
`startTurn` while another is active publishes a `lifecycle_violation`
diagnostic and drops the call.

For OpenCode we **never expect lifecycle violations** because the bus
is single-source — but keeping the strict mode means the dispatcher's
own bugs (e.g. forgetting to call `finishTurn` on `step.failed`)
surface loudly instead of silently corrupting state.

**Exports**: `class SemanticChannel extends EventEmitter` with all
methods named identically to existing packages.

**Deps**: `channels/types.ts`.

**Analog**: byte-near-identical to existing two packages. ~400 LOC.

---

### `src/channels/ScreenChannel.ts`

**WHY**: **kept for symmetry, mostly inert.** Downstream IDE code in
`agent-code` (the renderer's tile-tree, the dispatch system, the feed
renderer) switches on channel kind. Removing `ScreenChannel` entirely
forces a fork in the consumer code path; keeping it lets the IDE stay
provider-agnostic.

For OpenCode, we emit a small synthetic surface:
- `activity` — derived from `session.status` (`busy` ↔ `active`,
  `idle` ↔ inactive, `retry` and `compacting` ↔ active with a
  status verb). This is the analog of Claude's "Cogitating…" spinner
  but data-driven.
- We do NOT emit `snapshot`, `trust_dialog`, `resume_prompt`,
  `compaction` (the latter goes on `CommittedChannel.compact_boundary`
  via `session.compacted`), `slash_picker`.

**Exports**: `class ScreenChannel extends EventEmitter` matching the
existing class shape.

**Deps**: `channels/types.ts`.

**Analog**: existing two packages. ~80–120 LOC for the no-op subset.

---

### `src/channels/CommittedChannel.ts`

**WHY**: durable transcript events. Same vocabulary as the existing
packages: `turn_committed`, `entry`, `compact_boundary`, `tool_result`.
Fed by:
- the dispatcher on `message.updated` (turn_committed),
  `message.part.updated` (entry for non-tool parts, tool_result for
  completed tool parts), `session.compacted` (compact_boundary).
- the `HistoryClient` during cold snapshot or replay, replaying past
  rows in the same shape.

**Exports**: `class CommittedChannel extends EventEmitter`.

**Deps**: `channels/types.ts`, `transcript/TranscriptTypes.ts`.

**Analog**: existing two packages. ~150 LOC.

---

### `src/permissions/PermissionService.ts`

**WHY**: the single replacement for both Claude's
`PermissionPromptParser` + keystroke-callback approach and Codex's
entire `conditions/` framework. The wrapper exposes:

- A typed event the consumer subscribes to: `permissionRequested`
  carries `{ id, sessionID, permission, patterns, always, metadata,
  tool?: { messageID, callID }, resolver }`. The `resolver` is a
  function `(reply: "once" \| "always" \| "reject", message?: string)
  => Promise<void>` — the consumer calls it to answer.
- Queue of pending requests: `getPending(): PermissionRequest[]`,
  with `getApprovalState()` returning the active one (for UI parity
  with Codex's `getApprovalState()`).
- A race guard: the resolver is one-shot. Calling it after the request
  has been answered by another client (e.g. someone hit `reply` in a
  parallel TUI) returns a typed `AlreadyRespondedError`.
- Auto-reply mode: `{ autoReply: 'always' \| 'reject' \| ((req) =>
  Promise<reply>) }` for headless test harnesses and dangerously-skip
  flows.

**Exports**: `class PermissionService extends EventEmitter`,
`PermissionRequest`, `PermissionReply = "once" \| "always" \| "reject"`,
`AlreadyRespondedError`.

**Deps**: `transport/SyncClient.ts` (for the `POST` and the bus event
forwarding from the dispatcher).

**Analog**: replaces `parsers/PermissionPromptParser.ts` (~89 LOC) and
all of Codex's `conditions/` (~400 LOC) at once. ~200 LOC.

---

### `src/permissions/types.ts`

**WHY**: typed shapes for `PermissionRequest` and the reply contract.
Models exactly what comes over `permission.asked`
(`packages/sdk/js/src/v2/gen/types.gen.ts:2308-2322` —
`EventPermissionAsked`) plus the body of `POST
/permission/{id}/reply`. Includes the per-permission metadata
discriminator (the table in
`research/08-approval-and-permissions.md` §"Wire contract": `edit` →
`{filepath, diff}`, `bash` → tool input has `.command`, etc.) so
consumers can render previews without re-deriving the schema.

**Exports**: `PermissionRequest`, `PermissionMetadata` discriminated
union, `PermissionAxis = "read" \| "edit" \| "glob" \| "grep" \|
"list" \| "bash" \| "task" \| "external_directory" \| "todowrite" \|
"question" \| "webfetch" \| "websearch" \| "lsp" \| "doom_loop" \|
"skill" \| string` (open for MCP/plugins).

**Deps**: none.

**Analog**: Codex's `conditions/types.ts` minus the action plumbing
(actions become "call resolver"). ~80 LOC.

---

### `src/transcript/HistoryClient.ts`

**WHY**: the JSONL-tailer replacement. Three reattach paths from
`research/06`:

1. **Cold snapshot** — `GET /session/{id}/message` returns
   `WithParts[]`. Used on first attach and on full reattach.
2. **Replay-from-seq** — `POST /sync/history { aggregateID: lastSeq }`
   returns every `SyncEvent` with `seq > lastSeq`. Used after an SSE
   disconnect to catch up missed *durable* events. **Gated on
   `OPENCODE_EXPERIMENTAL_WORKSPACES`** — if disabled, history rows are
   not persisted and this endpoint returns empty; fall back to cold
   snapshot.
3. **Live tail** — handled by `SseClient`, not this file.

The `HistoryClient` also owns the 4-step reattach recipe (`research/06`
§"Reattach contract"):

```
1. open SSE /event           ← start buffering live events into a queue
2. GET  /session/:id/message ← cold snapshot
3. POST /sync/history        ← {sessionID: snapshotMaxSeq} (if enabled)
4. drain SSE buffer + apply  ← honor seq ordering for SyncEvents
                                arrival ordering for PartDelta
```

**Exports**: `class HistoryClient { snapshot(sessionID):
Promise<WithParts[]>; replay(seqMap): Promise<SyncEvent[]>;
reattach(sessionID, opts): Promise<ReattachResult> }`.

**Deps**: `transport/SyncClient.ts`, `transcript/TranscriptTypes.ts`.

**Analog**: replaces `transcript/JsonlTailer.ts` (~150 LOC). ~200–300 LOC.

---

### `src/transcript/TranscriptTypes.ts`

**WHY**: type model for OpenCode's `Session`, `Message`, `Part`,
`SyncEvent` envelopes. Mirrors
`packages/opencode/src/session/message-v2.ts` (especially the `Part`
discriminator at lines 405-447, ten variants:
`text|reasoning|tool|file|agent|step-start|step-finish|snapshot|patch|subtask|retry|compaction`)
and the SDK type union from `@opencode-ai/sdk/v2`. Includes type guards
(`isToolPart`, `isTextPart`, `isCompactionPart`).

For consumers that expect Claude/Codex `Entry` shapes (used by
`CommittedTurnEvent.entry`), this file also exposes
`toLegacyEntry(message, parts)` that flattens OpenCode's
`Message + Part[]` into the `ConversationEntry` shape from
`packages/claude-code-headless/src/transcript/TranscriptTypes.ts`. The
goal is for the renderer's existing per-entry code path to "just work"
when fed OpenCode data.

**Exports**: `Session`, `Message`, `Part`, `TextPart`, `ReasoningPart`,
`ToolPart`, `ToolPartState`, `CompactionPart`, `SyncEvent` (typed
discriminated union of every `EventTable.type`), type guards,
`toLegacyEntry()`.

**Deps**: `@opencode-ai/sdk/v2` (types only).

**Analog**:
`packages/claude-code-headless/src/transcript/TranscriptTypes.ts`. ~200–300 LOC.

---

### `src/transcript/ProjectKey.ts`

**WHY**: derive OpenCode's project ID from a cwd. The server uses
`git rev-list --max-parents=0 HEAD` (`packages/opencode/src/project/project.ts:248`),
i.e. the first-parent commit SHA. Repos with multiple roots get the
first one; non-git directories presumably have a fallback (TBD — see
§13). Caching one project key per `cwd` is cheap and safe; the SHA
doesn't change unless someone rewrites history at the root.

**Exports**: `getProjectKey(cwd: string): Promise<string>`,
`invalidateProjectKey(cwd: string)`.

**Deps**: `node:child_process` (for the `git` shell-out).

**Analog**: `packages/claude-code-headless/src/transcript/ProjectDir.ts`
(does the sanitize-cwd trick). ~50 LOC.

---

### `src/transcript/SessionList.ts`

**WHY**: enumerate sessions for a workspace. Wraps `sdk.session.list({
directory })` (v1) or `sdk.session.list({ workspaceID })` (v2). Returns
session info comparable to the existing two packages'
`SessionInfo` shape so the parent IDE can build session pickers
without provider-aware code.

**Exports**: `listSessionsForCwd(cwd: string, opts?: { limit?: number
}): Promise<SessionInfo[]>` plus a typed `SessionInfo` matching
existing-package conventions.

**Deps**: `transport/SyncClient.ts`, `transcript/ProjectKey.ts`,
`transcript/TranscriptTypes.ts`.

**Analog**:
`packages/claude-code-headless/src/transcript/SessionList.ts`,
`packages/codex-headless/src/transcript/SessionList.ts`. ~80–120 LOC.

---

### `src/spawn/listenLine.ts`

**WHY**: parsing the `opencode server listening on http://<host>:<port>`
line off stdout. The SDK does this in
`packages/sdk/js/src/v2/server.ts:51-69`; if we depend on the SDK we
don't need this file. If we vendor: this is the only stdout-scrape
contract.

**Exports**: `parseListenLine(line: string): { url: URL } \| null`,
`waitForListenLine(stream: Readable, timeoutMs: number):
Promise<URL>`.

**Deps**: none.

**Analog**: none. ~30 LOC.

---

### `src/testing/record.ts`, `replay.ts`, `verify.ts`

**WHY**: deterministic replay harness for the dispatcher. Each existing
package has these and they're useful for regressing event-handling
bugs. For OpenCode:
- `record.ts` — start the wrapper against a real `opencode serve`, run
  a scripted prompt, capture every SSE event to JSONL plus snapshots
  of every channel event emitted.
- `replay.ts` — feed a captured SSE JSONL stream into a fresh
  `EventDispatcher` and check the channel emissions match.
- `verify.ts` — regression runner.

**Honoring `feedback_no_test_bloat`** from memory: do not commit new
test files in the implementation PR. These harness files belong in a
follow-up cleanup PR. Spec them here so the design is captured; defer
the file creation.

**Exports**: same shape as
`packages/claude-code-headless/src/testing/{record,replay,verify}.ts`.

**Deps**: every file in the package.

**Analog**: ~100–200 LOC each.

---

### `EVENT_SPEC.md` (top-level, alongside `package.json`)

**WHY**: the OpenCode equivalent of
`packages/claude-code-headless/EVENT_SPEC.md`. Single source of truth
for the dispatcher's mapping table (§5 of this proposal lifted into
its own doc), the 72 SSE event variants, the unified `LLM.Event`
vocabulary from `session/processor.ts:220`, and the load-bearing
quirks (PartDelta is bus-only; `tool-input-delta` is ignored by the
processor; `signature` lives in `providerMetadata`).

**Replaces** the role both `EVENT_SPEC.md` and `PROXY_STREAMING.md`
play in the Claude package — there's no proxy here, so one doc covers
the wire surface entirely.

---

### `PROXY_STREAMING.md` stub

**WHY**: leave a one-line file: `# N/A — OpenCode is server-first; see
EVENT_SPEC.md`. Future-you will look for it because the other package
has it. Empty redirect prevents the dead-end search.

---

## 4. Public API — full TypeScript signatures

```ts
// src/OpencodeHeadless.ts

import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import type {
  SemanticEvent, ScreenEvent, CommittedEvent,
  LiveOwnerState,
} from './channels/types.js'
import { SemanticChannel } from './channels/SemanticChannel.js'
import { ScreenChannel } from './channels/ScreenChannel.js'
import { CommittedChannel } from './channels/CommittedChannel.js'
import {
  PermissionService, PermissionRequest, PermissionReply,
} from './permissions/PermissionService.js'

/**
 * Construction options. Exactly one of `spawn` and `serverUrl` MUST be
 * provided — they're mutually exclusive ways to acquire a server.
 *
 *   spawn       — library spawns `opencode serve` as a child process,
 *                 parses the listen-line, owns the lifetime. Closing
 *                 the OpencodeHeadless instance kills the server.
 *
 *   serverUrl   — caller already has an `opencode serve` instance
 *                 (perhaps spawned by agent-code's own session manager
 *                 so a Dispatch-to-native-terminal `opencode attach`
 *                 client can also connect). We just open SSE + HTTP
 *                 against it. Closing this instance does NOT kill the
 *                 server.
 *
 * The discriminated-union shape forces the caller to make the choice
 * explicit at the call site.
 */
export type OpencodeHeadlessOptions =
  | OpencodeHeadlessSpawnOptions
  | OpencodeHeadlessAttachOptions

export interface OpencodeHeadlessSpawnOptions {
  mode: 'spawn'
  /** Workspace cwd. Sent as `x-opencode-directory` on every request,
   *  used to derive the project key (git first-parent SHA), and passed
   *  as `--dir` to `opencode serve`. */
  cwd: string
  /** Optional explicit port. Default: 0 (random; opencode tries 4096
   *  then any free per `server/server.ts:293-298`). */
  port?: number
  /** Optional explicit hostname. Default: 127.0.0.1. Use 0.0.0.0
   *  only if you also want mDNS publishing. */
  hostname?: string
  /** Optional path to the `opencode` binary. Falls back to PATH lookup
   *  via cross-spawn. The `OPENCODE_BIN_PATH` env var also works
   *  (it's honored by the shim at packages/opencode/bin/opencode:20-23). */
  binaryPath?: string
  /** Server password for HTTP Basic auth. If omitted, we generate a
   *  random 32-byte hex value and inject it as
   *  OPENCODE_SERVER_PASSWORD. Setting one is mandatory in practice —
   *  serve.ts:15-17 prints a warning otherwise — so we always set
   *  one. */
  password?: string
  /** Resume an existing session by ID. If omitted, a new session is
   *  created on `start()`. */
  sessionID?: string
  /** Inject server config without writing the filesystem. Becomes
   *  OPENCODE_CONFIG_CONTENT for the child process. */
  config?: object
  /** v1 (`POST /session/{id}/message`) vs v2 (`POST
   *  /api/session/{id}/prompt`) prompt path. Default 'v2' (richer
   *  session.next.* events). See research/02 §"Gaps" — v2 is
   *  experimental, may change. */
  apiVersion?: 'v1' | 'v2'
  /** Reconnect timeouts and buffer ceilings. */
  tuning?: TuningOptions
  /** AbortSignal honored by start() and stop(). */
  signal?: AbortSignal
  /** Auto-reply mode for permissions. Default: surface each request
   *  on `permissionRequested` and wait for `replyToPermission`. */
  autoReply?: PermissionReply | ((req: PermissionRequest) => Promise<PermissionReply>)
}

export interface OpencodeHeadlessAttachOptions {
  mode: 'attach'
  /** Already-running server URL (typically `http://127.0.0.1:4096`). */
  serverUrl: string
  /** Workspace cwd — sent as x-opencode-directory header. */
  cwd: string
  /** Server password. REQUIRED for non-localhost; localhost may omit
   *  if the server was launched without one (it printed the warning
   *  about insecurity). */
  password?: string
  sessionID?: string
  apiVersion?: 'v1' | 'v2'
  tuning?: TuningOptions
  signal?: AbortSignal
  autoReply?: PermissionReply | ((req: PermissionRequest) => Promise<PermissionReply>)
}

export interface TuningOptions {
  /** SSE reconnect: initial backoff in ms. Default 250. */
  sseInitialBackoffMs?: number
  /** SSE reconnect: max backoff in ms. Default 10000. */
  sseMaxBackoffMs?: number
  /** PartAccumulator: per-part text byte ceiling. Default 1 MiB.
   *  Crossing this evicts the oldest deltas in that part. */
  partTextCeilingBytes?: number
  /** PartAccumulator: max number of active parts buffered. Default 64.
   *  LRU eviction. */
  partMaxActive?: number
  /** Listen-line timeout for spawn mode. Default 5000ms — matches the
   *  SDK's default. */
  serverSpawnTimeoutMs?: number
}

export class OpencodeHeadless extends EventEmitter {
  constructor(options: OpencodeHeadlessOptions)

  /** Lifecycle: spawn server (if mode=spawn), open SSE, attach to or
   *  create the session, prime the dispatcher with a cold snapshot.
   *  Idempotent — calling twice is a no-op after the first success.
   *
   *  Throws on: spawn failure (binary missing, listen-line timeout),
   *  auth failure (Basic auth rejected), missing/invalid sessionID
   *  on resume. */
  start(): Promise<void>

  /** Lifecycle: close SSE, dispose instance (POST /instance/dispose
   *  if we spawned the server), kill child, flush part accumulator.
   *  Safe to call multiple times. Honors options.signal aborts. */
  stop(): Promise<void>

  /** Send a user prompt. Returns the new `messageID` synchronously
   *  (after the server enqueues, before any tokens stream — those
   *  arrive on the SemanticChannel).
   *
   *  Throws on: not started, no active session, abort. */
  sendPrompt(
    text: string,
    opts?: {
      /** Provider + model. Required if no session-default exists. */
      model?: { providerID: string, modelID: string }
      /** Override agent (e.g. 'plan', 'explore'). */
      agent?: string
      /** Force the API path. Falls through to constructor default. */
      apiVersion?: 'v1' | 'v2'
      /** Abort just this prompt (separate from stop()). */
      signal?: AbortSignal
    }
  ): Promise<{ messageID: string }>

  /** POST /session/{id}/abort. Returns when the server has
   *  acknowledged; the SemanticChannel will see `turn_stopped` shortly
   *  after as the agent loop tears down. */
  abort(): Promise<void>

  /** Reply to a pending permission request. Pass-through to
   *  PermissionService.reply. */
  replyToPermission(
    requestID: string,
    reply: PermissionReply,
    message?: string,
  ): Promise<void>

  /** Channel accessors. Consumers subscribe via channel.on('event', ...)
   *  or channel.on('<type>', ...) for the typed sub-events. */
  getSemanticChannel(): SemanticChannel
  getScreenChannel(): ScreenChannel
  getCommittedChannel(): CommittedChannel

  /** State queries. */
  isIdle(): boolean
  isWorking(): boolean
  getActivity(): { active: boolean, verb: string | null }
  getApprovalState(): PermissionRequest | null
  getLiveOwner(): LiveOwnerState  // always { kind: 'server', … } for opencode
  getActiveSessionID(): string | null

  /** Legacy flat events (for parity with existing two packages).
   *  Prefer the channel API; these exist so the agent-code workspace
   *  store doesn't fork its switch. */
  on(event: 'event', listener: (e: SemanticEvent | ScreenEvent | CommittedEvent) => void): this
  on(event: 'idle', listener: () => void): this
  on(event: 'activity', listener: (e: { active: boolean, verb: string | null }) => void): this
  on(event: 'permissionRequested', listener: (req: PermissionRequest) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'exit', listener: (info: { code: number | null, signal: string | null }) => void): this
  // …plus standard EventEmitter overloads
}
```

Channel event types are the same union as
`packages/claude-code-headless/src/channels/types.ts:709-731` —
imported verbatim. The dispatcher emits the subset of variants
OpenCode can produce (every one except `signature`, `citations_delta`,
`connector_text_delta`, `flow_selected`, `flow_ignored` — see §5).

---

## 5. The 72 SSE events — full dispatcher mapping

> Source for the variant list: research/02 §"SSE event vocabulary"
> (the `oneOf` schema in `openapi.json` has 72 variants), the `Event`
> union in `packages/sdk/js/src/v2/gen/types.gen.ts:704-736` (32
> top-level v1 names), and the v2 `session-event.ts` family
> (`packages/opencode/src/v2/session-event.ts:33-393`). Where the two
> generations disagree I list both names with the v2 mapping primary.
>
> Columns: **Event** (OpenCode bus type), **Channel**, **Channel
> event** (the typed variant we emit), **Source** (always `'proxy'`
> in `SemanticSource` terms — for OpenCode this means "from the live
> wire" — even though there's no actual mitmproxy), **Confidence**
> (always `high` for first-party server emissions; `medium` for
> derived state), **Notes**.

### 5.1 Streaming text — `session.next.text.*`

| Event | Channel | Channel event | Confidence | Notes |
|---|---|---|---|---|
| `session.next.text.started` | Semantic | `block_started` (kind=`text`) | high | Mints a `partID`-based blockIndex; turnTracker opens a turn if one isn't open. |
| `session.next.text.delta` | Semantic | `text_delta` | high | `textDelta` is the chunk; `textSoFar` is the accumulator from `partAccumulator`. |
| `session.next.text.ended` | Semantic | `block_completed` (kind=`text`) | high | The corresponding `message.part.updated` confirms persistence; committed-channel emit follows. |

### 5.2 Streaming reasoning — `session.next.reasoning.*`

| Event | Channel | Channel event | Confidence | Notes |
|---|---|---|---|---|
| `session.next.reasoning.started` | Semantic | `block_started` (kind=`thinking`) | high | |
| `session.next.reasoning.delta` | Semantic | `thinking_delta` | high | OpenAI `reasoning_summary` interleaving is normalized by the AI SDK; we see one stream of deltas regardless of provider. |
| `session.next.reasoning.ended` | Semantic | `block_completed` (kind=`thinking`) | high | If `providerMetadata.anthropic.signature` is present, **also** emit a `signature` semantic event. Field name unconfirmed (research/05 §"Open questions"). |

### 5.3 Tool input streaming — `session.next.tool.input.*`

| Event | Channel | Channel event | Confidence | Notes |
|---|---|---|---|---|
| `session.next.tool.input.started` | Semantic | `block_started` (kind=`tool_use`) | high | `toolName` and `toolUseId` (= AI SDK's `toolCallId`) are populated. |
| `session.next.tool.input.delta` | Semantic | `tool_input_delta` | high | Forward `partialJson` as the raw fragment; `inputJsonSoFar` from `partAccumulator`. **Caveat** (research/05 §"Open questions" #3): `processor.ts:305-307` ignores `tool-input-delta` for projection; whether the AI SDK re-publishes on the bus is unconfirmed. If it doesn't, we won't see this and the renderer falls back to one shot at `tool_input_finalized`. |
| `session.next.tool.input.ended` | Semantic | `tool_input_finalized` | high | Final assembled JSON; try `JSON.parse`, populate `parsed` or `parseError`. |

### 5.4 Tool execution — `session.next.tool.*`

| Event | Channel | Channel event | Confidence | Notes |
|---|---|---|---|---|
| `session.next.tool.called` | (none) | — | — | Already covered by `tool_input_finalized` at the channel level; consumed by turnTracker for `stream_phase = 'awaiting-tool'` transition. |
| `session.next.tool.progress` | Semantic | (custom — see notes) | high | OpenCode's `shell` tool mutates `ToolPart.state.metadata` mid-run (`research/09` §6); this surfaces as `tool.progress` events. We don't have a `tool_progress_delta` semantic variant in the existing channels — emit it as a `block_completed`-style synthetic with the latest `metadata.output` snapshot, OR add a new variant. Recommendation: **add `tool_progress` to `channels/types.ts`** in the same PR; existing packages can adopt it later. |
| `session.next.tool.success` | Semantic | `tool_result` (isError=false) + Committed `tool_result` | high | `content` = `state.output` (string). Always emit both channels: live `tool_result` on Semantic so the renderer can pair it to the originating `tool_use` block, durable `tool_result` on Committed so history rebuilds correctly. |
| `session.next.tool.failed` | Semantic | `tool_result` (isError=true) + Committed `tool_result` | high | `content` = `state.error`. |

### 5.5 Step boundaries — `session.next.step.*`

| Event | Channel | Channel event | Confidence | Notes |
|---|---|---|---|---|
| `session.next.step.started` | Semantic | `turn_started` (when first step of a turn) | high | A turn has 1..N steps; turnTracker opens the turn on the first step. Carries `model` info → also fires `model.switched`-equivalent metadata. |
| `session.next.step.ended` | Semantic | `usage_updated` + (conditional) `turn_completed` | high | Usage usually arrives here. The turn closes when the step is final (`session.status:idle` is authoritative — see 5.13). |
| `session.next.step.failed` | Semantic | `stream_error` (soft) or `api_error` (hard, on `error.type`) | high | Mirrors Claude's stream-error/api-error split. |

### 5.6 Shell — `session.next.shell.*`

| Event | Channel | Channel event | Confidence | Notes |
|---|---|---|---|---|
| `session.next.shell.started` | (none) | — | — | Internal — surfaced via the underlying `tool` events for the `shell` tool. |
| `session.next.shell.ended` | (none) | — | — | Same. |

### 5.7 Compaction — `session.next.compaction.*`

| Event | Channel | Channel event | Confidence | Notes |
|---|---|---|---|---|
| `session.next.compaction.started` | Screen | `activity` (`active: true, verb: 'Compacting…'`) | medium | Plus Committed `compact_boundary` placeholder if you want the renderer to show a stub immediately; recommend deferring to the `.ended` event so we don't render half-baked state. |
| `session.next.compaction.delta` | (none) | — | — | The compaction summary text doesn't need streaming — the user-facing surface is "a compaction happened, here's what was kept". Drop. |
| `session.next.compaction.ended` | Committed | `compact_boundary` | high | Pair with the `session.compacted` event (5.13) for the durable confirmation. |

### 5.8 Retries — `session.next.retried`

| Event | Channel | Channel event | Confidence | Notes |
|---|---|---|---|---|
| `session.next.retried` | Screen | `activity` (`verb: 'Retrying (N)'`) | high | Carries `{ attempt, message, next }` per `session/status.ts:10-26`. Useful state: don't hide retries from the user. |

### 5.9 Switches & misc — `session.next.*`

| Event | Channel | Channel event | Confidence | Notes |
|---|---|---|---|---|
| `session.next.agent.switched` | (none, metadata) | metadata on next `turn_started` | high | Track current agent in `OpencodeHeadless` state; reflect in legacy `activity` event for status-row UI. |
| `session.next.model.switched` | (none, metadata) | metadata on next `turn_started` | high | Same. |
| `session.next.prompted` | Committed | `entry` (for the user message that was synthesized server-side) | high | Server may inject a synthetic prompt (e.g. autocompact continuation). |
| `session.next.synthetic` | Committed | `entry` | medium | Catch-all for server-injected messages. |

### 5.10 Legacy/v1 message events — `message.*`

These flow on the bus in parallel with the v2 `session.next.*` family
(the v2 stream is currently dual-write per `processor.ts:228,262,280`
comments). If both v1 and v2 fire for the same logical event, the
dispatcher MUST de-duplicate by `(partID, type)` — prefer v2 events
because they carry richer typing.

| Event | Channel | Channel event | Confidence | Notes |
|---|---|---|---|---|
| `message.updated` | Committed | `turn_committed` (when role=user, OR when assistant message becomes durable with `time.completed != null`) | high | Source of truth for the durable transcript line. |
| `message.removed` | Committed | (custom — needs a `entry_removed` variant?) | high | No existing channel event maps. Recommend: emit a `committed` `entry` with a synthetic marker, OR add `entry_removed` to the channel types in the same PR. |
| `message.part.updated` | Semantic + Committed (split per `part.type`) | see notes | high | This is the v1 path for everything in §5.1-5.4. For `text` and `reasoning` parts, project to Semantic as `block_completed`. For `tool` parts, dispatch by `state.status` (`pending`→`block_started`, `running`→ ignore (we already opened on `pending`), `completed`→`tool_result` + Committed, `error`→`tool_result(isError)` + Committed). For `compaction`, project to Committed `compact_boundary`. For `step-start`/`step-finish`, route to turnTracker. |
| `message.part.removed` | Committed | (custom) | high | Mirror to `message.removed`. |
| `message.part.delta` | Semantic | `text_delta` / `thinking_delta` / `tool_input_delta` (by `field`) | high | **Bus-only, never persisted** (research/06 §"Live-vs-lazy"). MUST be captured in `partAccumulator` keyed by `partID` so we survive an SSE drop. |

### 5.11 Sessions — `session.*`

| Event | Channel | Channel event | Confidence | Notes |
|---|---|---|---|---|
| `session.created` | (none) | metadata, drives `getActiveSessionID()` | high | |
| `session.updated` | (none) | metadata | high | Title changes, permission ruleset edits. |
| `session.deleted` | (none) | causes `OpencodeHeadless` to clear active state, emit `exit` | high | If we deleted, we initiated; if someone else did, that's a hard surprise — log loudly. |
| `session.diff` | (none) | metadata | medium | Could surface as committed `entry` with the snapshot diff. |
| `session.error` | Semantic | `api_error` or `stream_error` (by severity) | high | Catch-all for server-side errors that don't fit a specific stream phase. |
| `session.status` | Screen + Semantic | `activity` + `turn_completed` (on `idle` after live turn) | high | **Authoritative turn-done signal** (research/02 §"Turn-done signal"). turnTracker uses `status.type === 'idle'` to close the active turn. |
| `session.idle` | Screen | `activity` (`active: false`) | high | Deprecated alias; back-compat for older servers. Dedupe against `session.status:idle`. |
| `session.compacted` | Committed | `compact_boundary` | high | Pairs with `session.next.compaction.ended`. |

### 5.12 Permissions — `permission.*`

| Event | Channel | Channel event | Confidence | Notes |
|---|---|---|---|---|
| `permission.asked` | (PermissionService) | `permissionRequested` (legacy flat) | high | Forwarded into PermissionService; service emits `permissionRequested` on the OpencodeHeadless instance with a resolver. |
| `permission.replied` | (PermissionService) | internal | high | Closes the pending request; one-shot race-safe. |
| `permission.updated` | (PermissionService) | internal | high | Used by other clients (TUI, web) to learn that a `permission.replied` fired for someone else's request — guards our resolver against double-fire. |

### 5.13 Questions — `question.*`

OpenCode's `question` tool is a structured "ask the user a question"
flow (research/09 §1, `QuestionTool` in `tool/registry.ts:219`).
Different from `permission` because the question is content, not a
gate.

| Event | Channel | Channel event | Confidence | Notes |
|---|---|---|---|---|
| `question.asked` | Screen | (custom — see notes) | high | Mirror `permission.asked` shape but on its own track. Add a `question_requested` variant on `ScreenChannel` or `OpencodeHeadless` legacy events. The renderer treats it as an inline tool overlay, not a gate. |
| `question.replied` | (internal) | — | high | |
| `question.rejected` | (internal) | — | high | |

### 5.14 PTY — `pty.*`

OpenCode's server can host arbitrary PTYs (`research/03` §"v1
namespaces" — `pty` namespace) for user-facing terminals. These are
NOT the agent runtime; they're a feature for the TUI / web client to
host shells. **Skip in `opencode-headless`** unless agent-code wants to
expose them (it currently doesn't — agent-code's own session manager
owns terminals).

| Event | Channel | Channel event | Notes |
|---|---|---|---|
| `pty.created`, `pty.updated`, `pty.exited`, `pty.deleted` | — | — | Forward to a `pty` event on the OpencodeHeadless instance for callers that want it; never project to channels. |

### 5.15 TUI — `tui.*`

Server-emitted, consumed by the TUI client itself. The TUI publishes
toasts and commands via `POST /tui/*`. As an SDK consumer we don't
need to render the toasts unless we want UX parity.

| Event | Channel | Channel event | Notes |
|---|---|---|---|
| `tui.toast.show` | Screen | `activity` (with verb='Notice: …') OR ignored | Recommend ignore for v1; render in a follow-up if useful. |
| `tui.command.execute` | (none) | — | Plugin/server-initiated slash-command execution. |
| `tui.prompt.append` | (none) | — | Server-side trigger for a TUI prompt mutation. |

### 5.16 Files & VCS — `file.*`, `vcs.*`

| Event | Channel | Channel event | Notes |
|---|---|---|---|
| `file.edited` | (none) | — | Useful for an agent-code "files touched this turn" tracker — forward to a separate event on the OpencodeHeadless instance. |
| `file.watcher.updated` | (none) | — | Internal — server lets clients know it noticed external file changes. |
| `vcs.branch.updated` | (none) | — | Forward for status-row rendering. |

### 5.17 LSP — `lsp.*`

| Event | Channel | Channel event | Notes |
|---|---|---|---|
| `lsp.client.diagnostics` | (none) | — | Forward for the editor surface. |
| `lsp.updated` | (none) | — | LSP server registration changes. |

### 5.18 MCP — `mcp.*`

| Event | Channel | Channel event | Notes |
|---|---|---|---|
| `mcp.tools.changed` | (none) | — | Tool registry mutation. Forward to `OpencodeHeadless` MCP-state listener; consumers refresh their cached tool list. |
| `mcp.browser.open.failed` | (none) | (forward) | OAuth-launch failure; show a manual URL prompt. |
| `mcp.status` (implicit via Status discriminator) | (none) | — | Forward `needs_auth` status — research/09 §3 §7 — this is a real gap vs Claude/Codex. |

### 5.19 Todos & Commands

| Event | Channel | Channel event | Notes |
|---|---|---|---|
| `todo.updated` | Committed | `entry` | Maps to the existing `todowrite` block conventions in the renderer. |
| `command.executed` | Committed | `entry` (synthetic for slash-command runs) | |

### 5.20 Installation, IDE, worktree, workspace

| Event | Channel | Channel event | Notes |
|---|---|---|---|
| `installation.updated`, `installation.update.available` | (none) | (forward) | Self-update nag. Optional rendering. |
| `worktree.*` (if it surfaces) | (none) | — | Worktree primitives — research/09 §4 plugin contract mentions `experimental_workspace`. Forward as-is; consumer decides. |
| `workspace.*` | (none) | — | Same. |

### 5.21 Server lifecycle

| Event | Channel | Channel event | Notes |
|---|---|---|---|
| `server.connected` | (none) | initial liveness signal | First event on `/event`; not a channel emission. |
| `server.heartbeat` | (none) | drives SSE keepalive | Reset SSE-stale watchdog; do NOT emit anything. |
| `server.instance.disposed` | (none) | causes graceful `OpencodeHeadless.stop()` | Server is shutting down; SSE will close. |

### 5.22 Catch-all — `bus.*` and unknown

| Event | Channel | Channel event | Notes |
|---|---|---|---|
| any unknown event type | (none) | log + diagnostic | Emit on `OpencodeHeadless` as a `unknownEvent` event with the raw payload. Do NOT silently drop — the bus might gain new variants and we want telemetry. |

### Events I couldn't fully resolve from research

The following are mentioned in research/02 / research/03 but their
full payload shapes weren't enumerated. Implementation MUST verify the
shapes by `curl`-ing a live server:

1. The exact field names on `session.status` for `retry` / `compacting`
   sub-statuses (`research/02` referenced `status.ts:10-26` but I
   haven't seen the full type).
2. Whether `EventTodoUpdated` carries the full todo list or just a
   diff.
3. The `EventCommandExecuted` payload shape — does it carry stdout/stderr
   or only the command id?
4. `experimental.*` event variants — research touched on
   `experimental_workspace.register` plugin hook but not the bus
   events.

Treat these as the second wave of mapping work, after PR-1 lands.

---

## 6. Reconnect / reattach state machine

```
                  ┌────────────────────────────────┐
                  │ NotStarted (initial)            │
                  └──────────────┬─────────────────┘
                                 │ start()
                                 ▼
                  ┌────────────────────────────────┐
                  │ Connecting                      │
                  │                                 │
                  │ if mode=spawn: spawn server,    │
                  │   await listen-line             │
                  │ else: just hold the URL         │
                  │ then open SSE, await            │
                  │   server.connected              │
                  └──────────────┬─────────────────┘
                                 │ server.connected
                                 ▼
                  ┌────────────────────────────────┐
                  │ AttachingSession                │
                  │                                 │
                  │ if opts.sessionID:              │
                  │   GET /session/{id}/message     │
                  │   POST /sync/history if enabled │
                  │ else:                           │
                  │   POST /session                 │
                  └──────────────┬─────────────────┘
                                 │ session ready
                                 ▼
                  ┌────────────────────────────────┐
                  │ Live ◀────────────┐             │
                  │                   │             │
                  │ SSE events flow   │  drain      │
                  │ through dispatch  │  SSE buffer │
                  │ partAccumulator   │             │
                  │ buffers deltas    │             │
                  └────┬──────────┬───┘             │
                       │          │                 │
            sse drop / │          │ stop()          │
            timeout    ▼          ▼                 │
                  ┌────────────────────────────────┐│
                  │ Reconnecting                    ││
                  │                                 ││
                  │ exponential backoff             ││
                  │ partAccumulator state preserved ││
                  └──────────────┬─────────────────┘│
                                 │ SSE re-open      │
                                 ▼                  │
                  ┌────────────────────────────────┐│
                  │ Resyncing                       ││
                  │                                 ││
                  │ POST /sync/history with         ││
                  │   aggregateID:lastSeqWeSaw      ││
                  │   (skip if experimental flag    ││
                  │    off — fall back to cold      ││
                  │    snapshot)                    ││
                  │ apply replayed SyncEvents       ││
                  │ check partAccumulator for       ││
                  │   in-flight parts; emit         ││
                  │   reconciliation events         ││
                  └──────────────┬─────────────────┘│
                                 │                  │
                                 └──────────────────┘
                                                    │
                                 ┌──────────────────┘
                                 │ stop() from any state
                                 ▼
                  ┌────────────────────────────────┐
                  │ Stopping                        │
                  │                                 │
                  │ close SSE                       │
                  │ if mode=spawn:                  │
                  │   POST /instance/dispose        │
                  │   kill child                    │
                  │ flush partAccumulator           │
                  └──────────────┬─────────────────┘
                                 │
                                 ▼
                  ┌────────────────────────────────┐
                  │ Stopped (terminal)              │
                  └────────────────────────────────┘
```

### Transition details

| From | Trigger | Action | Channel emissions | To |
|---|---|---|---|---|
| NotStarted | `start()` | spawn or attach | (none) | Connecting |
| Connecting | listen-line parsed / URL valid | open SSE; auth header | (none) | (still Connecting until `server.connected`) |
| Connecting | `server.connected` SSE event | mark live | (none — `server.connected` is not a channel event) | AttachingSession |
| Connecting | listen-line timeout | `stop()` + error | `error` (legacy flat) | Stopped |
| Connecting | auth 401 | `stop()` + error | `error` | Stopped |
| AttachingSession | `POST /session` 200 (new session) | record `sessionID` | (none) | Live |
| AttachingSession | `GET /session/{id}/message` 200 (resume) | replay rows through Committed channel | many `CommittedEvent` of type `entry` | (still AttachingSession until `POST /sync/history` returns) |
| AttachingSession | `POST /sync/history` 200 | drain replay queue | depends on rows | Live |
| Live | typed SSE event | dispatch through EventDispatcher | per §5 | Live |
| Live | SSE connection drop | start exponential backoff | (none, internal) | Reconnecting |
| Live | server-side `server.instance.disposed` | graceful teardown | `exit` legacy | Stopping → Stopped |
| Reconnecting | backoff fires, fetch starts | (none) | (none) | (still Reconnecting) |
| Reconnecting | SSE re-opens, `server.connected` arrives | (none) | (none) | Resyncing |
| Reconnecting | total reconnect time exceeds threshold | abort, emit error | `error` | Stopped |
| Resyncing | `POST /sync/history` 200 with rows | apply each `SyncEvent` row, comparing seq | Committed events for catch-up | Live |
| Resyncing | `POST /sync/history` 404 / experimental flag off | fall back to full `GET /session/{id}/message` | full cold replay | Live |
| Resyncing | mid-flight parts in `partAccumulator` reconciled | emit synthetic `block_completed` for any part the snapshot confirmed | Semantic | Live |
| Live, Reconnecting, Resyncing | `stop()` | close SSE; dispose | (none) | Stopping |
| Stopping | SSE closed, child killed | done | `exit` | Stopped |

### partAccumulator behavior across transitions

- Live → Reconnecting: keep state. We may still see the final
  `text-end` from the same SSE re-open, in which case the accumulator
  resolves the part cleanly.
- Reconnecting → Resyncing → Live: the snapshot from `/session/.../message`
  may show the part as `text=""` (the empty placeholder) or as the
  final committed text. If final: emit `block_completed` from the
  snapshot, drop our accumulator's copy. If still empty: keep
  accumulating until we either see the SSE end or another snapshot
  confirms completion.
- Stopping: flush the accumulator with synthetic `block_completed` for
  every in-flight part using whatever we have buffered, marked
  `confidence: 'medium'` so consumers know it's partial.

### Buffer eviction policy

- Default ceiling: 1 MiB per part text, 64 active parts.
- LRU on per-part age (last-delta timestamp).
- On overflow: emit `partAccumulator.overflow` legacy event with
  `{ partID, evicted: 'oldest' \| 'this' }`. Consumer can show "text
  truncated, refresh to see full message".

---

## 7. Permission system — full spec

### Wire shapes (cross-package canonical)

`permission.asked` SSE event payload (from research/08 §"Wire
contract" and
`packages/sdk/js/src/v2/gen/types.gen.ts:2308-2322`):

```ts
interface PermissionAskedEvent {
  id: string                     // event id
  type: 'permission.asked'
  properties: PermissionRequest
}

interface PermissionRequest {
  id: string                     // PermissionID (KSUID); the reply key
  sessionID: string
  permission: PermissionAxis     // 'edit' | 'read' | 'bash' | ... open set
  patterns: string[]             // what THIS call needs approved
  always: string[]               // what "always" would approve
  metadata: PermissionMetadata   // permission-specific; discriminated below
  tool?: {                       // optional — present for tool-driven asks
    messageID: string
    callID: string
  }
}

// Discriminator: by `permission` value
type PermissionMetadata =
  | { permission: 'edit',
      filepath: string,
      diff: string }
  | { permission: 'read',
      filepath: string }
  | { permission: 'glob' | 'grep',
      pattern: string }
  | { permission: 'list',
      path: string }
  | { permission: 'bash',
      command: string,           // sourced from tool input, NOT metadata —
                                 // see research/08 §"Wire contract"
      description?: string }
  | { permission: 'task',
      subagent_type: string,
      description: string }
  | { permission: 'webfetch',
      url: string }
  | { permission: 'websearch',
      query: string }
  | { permission: 'external_directory',
      parentDir: string,
      filepath: string,
      patterns: string[] }
  | { permission: 'doom_loop' }
  | { permission: 'todowrite' }
  | { permission: 'skill',
      skillName: string }
  | { permission: 'lsp' }
  | { permission: string,        // MCP / plugin tools
      [k: string]: unknown }
```

The reply contract — `POST /permission/{requestID}/reply`:

```ts
interface PermissionReplyBody {
  reply: 'once' | 'always' | 'reject'
  message?: string  // optional correction text on reject
}
```

Reject with `message` raises `PermissionCorrectedError` server-side
(research/08 §"Response"), surfacing the user's correction back to the
model as tool feedback. Reject without a message raises
`PermissionRejectedError`.

### Internal API of `PermissionService`

```ts
import { EventEmitter } from 'node:events'

export type PermissionReply = 'once' | 'always' | 'reject'

export interface PermissionReplyOptions {
  message?: string  // only meaningful when reply === 'reject'
}

export class PermissionService extends EventEmitter {
  constructor(opts: {
    sync: SyncClient
    autoReply?: PermissionReply | ((req: PermissionRequest) => Promise<PermissionReply>)
  })

  /** Called by EventDispatcher on permission.asked. Mints a resolver
   *  and emits 'permissionRequested' upward. If autoReply is configured,
   *  resolves immediately and skips the emission. */
  enqueue(req: PermissionRequest): void

  /** Called by the consumer (or by OpencodeHeadless.replyToPermission).
   *  Throws AlreadyRespondedError if the request was already answered
   *  by another client (per permission.replied / permission.updated). */
  reply(requestID: string, reply: PermissionReply, message?: string): Promise<void>

  /** Mark a request as externally resolved (someone else replied via
   *  the bus). Closes the resolver as a no-op. */
  markExternallyResolved(requestID: string): void

  /** Queue accessors. */
  getPending(): PermissionRequest[]
  getActive(): PermissionRequest | null

  /** Events. */
  on(event: 'permissionRequested', listener: (req: PermissionRequest) => void): this
  on(event: 'permissionResolved', listener: (info: { requestID: string, reply: PermissionReply | 'external' }) => void): this
}

export class AlreadyRespondedError extends Error {
  constructor(public requestID: string) {
    super(`Permission ${requestID} already resolved`)
  }
}
```

### Race semantics

OpenCode's permission system is shared — TUI, web app, and our wrapper
all see the same `permission.asked` event and can all `POST` a reply.
**First POST wins**; subsequent POSTs are silent no-ops on the server
(research/08 §"Gaps" #2). Our wrapper handles this via:

1. We always listen for `permission.replied` and
   `permission.updated`. When one arrives for a `requestID` whose
   resolver is still pending, we call `markExternallyResolved` to close
   it.
2. The resolver's promise rejects with `AlreadyRespondedError` so the
   UI knows to dismiss the prompt without showing a duplicate "you
   already answered" toast.

### Auto-reply modes

- `'always'` — every request → `{ reply: 'once' }`. Mirrors `opencode
  run --dangerously-skip-permissions`. Use for headless test harnesses.
- `'reject'` — every request → `{ reply: 'reject' }`. Use for "agent
  loop is broken, don't let it touch anything" containment.
- function → custom logic. Lets the consumer build allowlists or
  delegate to a UI.

### What this replaces in the other packages

| Existing file | Role | OpenCode equivalent |
|---|---|---|
| `claude-code-headless/src/parsers/PermissionPromptParser.ts` | Detect approval dialog from screen | gone — `permission.asked` arrives typed |
| `claude-code-headless` keystroke approval callback (in `ClaudeCodeHeadless.ts`) | Send `\r` or `3\r` to PTY | gone — `POST /permission/{id}/reply` |
| `codex-headless/src/parsers/ApprovalParser.ts` | Detect approval overlay from screen | gone |
| `codex-headless/src/conditions/approval.ts` | Synthesize a condition with actions | gone — the wire event IS the condition |
| `codex-headless/src/conditions/types.ts` `ConditionPtyAction` | The keystroke contract | gone — replaced by `PermissionReply` enum |

---

## 8. Transcript / persistence — full spec

### On-disk layout

| Item | Path |
|---|---|
| Database file | `${XDG_DATA_HOME}/opencode/opencode.db` (channel-suffixed for `dev`/`canary`) |
| Override env | `OPENCODE_DB=:memory:` or absolute path |
| Legacy JSON storage | `${XDG_DATA_HOME}/opencode/storage/{project,session,message,part,todo,permission,session_share}/...` (migrated into sqlite on startup) |
| Plans | `<worktree>/.opencode/plans/` (project) or `${data}/plans` (global) |
| Logs | `${XDG_DATA_HOME}/opencode/log/` |
| Cache | `${XDG_CACHE_HOME}/opencode/` |

Sources: `packages/opencode/src/storage/db.ts:30-43,96-101`,
`packages/core/src/global.ts:9-29`.

We don't touch this directly — everything comes through the HTTP API.
Documenting it so the implementation session knows where to look if
they're forensic-debugging.

### SQLite schema (read-only from our side)

| Table | PK | Notable columns |
|---|---|---|
| `session` | `id` (ULID) | `project_id`, `workspace_id?`, `parent_id?`, `directory`, `path`, `title`, `version`, `agent`, `model{json}`, `permission{json}`, `summary_*`, `revert{json}`, `time_{created,updated,compacting,archived}` |
| `message` | `id` (ULID) | `session_id`, `time_created`, `data{json}` (entire User or Assistant envelope minus id/sessionID) |
| `part` | `id` (ULID) | `message_id`, `session_id`, `time_created`, `data{json}` (discriminated `Part` minus ids) |
| `event_sequence` | `aggregate_id` (=sessionID) | `seq`, `owner_id?` |
| `event` | `id` | `aggregate_id`, `seq`, `type` (`<name>.<version>`), `data{json}` |
| `PermissionTable` | id | persisted "always-allow" rules (`packages/opencode/src/session/session.sql.ts:125`) |

Project ID is the **first-parent commit SHA** —
`packages/opencode/src/storage/storage.ts:116-119`,
`packages/opencode/src/project/project.ts:248`.

### Hybrid live/lazy contract

| Event | Kind | DB write? | Bus emit? | Cold-snapshot recovery? |
|---|---|---|---|---|
| `message.updated` | `SyncEvent` | yes (immediate tx) | yes | yes |
| `message.removed` | `SyncEvent` | yes | yes | yes |
| `message.part.updated` | `SyncEvent` | yes (immediate tx) | yes | yes |
| `message.part.removed` | `SyncEvent` | yes | yes | yes |
| `message.part.delta` | `BusEvent` | **no** | yes | **no** |
| `session.next.*.delta` | `BusEvent` (v2) | **no** | yes | **no** |
| `session.created`/`.updated`/`.deleted` | `SyncEvent` | yes | yes | yes |
| `session.compacted` | `SyncEvent` (via `compaction` part) | yes | yes | yes |
| `permission.asked`/`.replied`/`.updated` | `BusEvent` | no (state is in-memory `pending` Map) | yes | partial — `GET /permission` returns currently-pending requests |
| heartbeat / connected | n/a | no | yes | n/a |

The implications were named in §6: `partAccumulator` buffers deltas in
memory so we can survive a disconnect, then reconciles against the
eventual `message.part.updated` from the snapshot.

### Three reattach paths

1. **Cold snapshot** — `GET /session/{id}/message` returns
   `WithParts[]`. Used on first attach and on full reattach when
   `POST /sync/history` is unavailable.
2. **Replay-from-seq** — `POST /sync/history` with
   `{ aggregateID: lastSeq }` returns every `SyncEvent` with
   `seq > lastSeq`. Gated on `OPENCODE_EXPERIMENTAL_WORKSPACES`
   (research/06 §"Open questions"). If the flag is off in default
   installs, `/sync/history` returns empty and `HistoryClient.replay`
   detects this (no rows after a known-active session) and falls back
   to cold snapshot. **This MUST be confirmed before code (see §13).**
3. **Live tail** — `SseClient.connect()`. Strictly live, no replay.

### `WithParts` shape (what `GET /session/{id}/message` returns)

```ts
interface WithParts {
  message: Message
  parts: Part[]
}

interface Message {
  id: string
  sessionID: string
  time: { created: number, completed?: number }
  // … role/role-specific fields
}

interface Part {
  id: string
  messageID: string
  sessionID: string
  type: 'text' | 'reasoning' | 'tool' | 'file' | 'agent' |
        'step-start' | 'step-finish' | 'snapshot' | 'patch' |
        'subtask' | 'retry' | 'compaction'
  // … type-specific fields per research/06 §"Part variants"
}
```

The `toLegacyEntry` helper in `TranscriptTypes.ts` flattens `Message +
Part[]` into the `ConversationEntry` shape the existing renderer
consumes.

### Compaction handling

OpenCode has a first-class `CompactionPart` (research/06 §"Compaction"):

```ts
{ type: 'compaction',
  auto: boolean,
  overflow?: boolean,
  tail_start_id?: MessageID }
```

When the dispatcher sees a `message.part.updated` for a compaction
part, emit a `CommittedCompactBoundaryEvent` carrying the part data
mapped into the existing-package envelope. The renderer's existing
compact-boundary handling (used today for Claude's
`compact_boundary` JSONL entries) "just works".

---

## 9. Tools, MCP, plugins — full mapping

### Built-in catalog (15 tools)

From `packages/opencode/src/tool/registry.ts:196-234`. Compared to
Claude's ~30-tool catalog from
`packages/claude-code-headless/EVENT_SPEC.md:170-191`.

| OpenCode tool | Claude/Codex analog | Approval axis | Streaming progress | Notes |
|---|---|---|---|---|
| `invalid` | n/a | n/a | n/a | Sentinel for unknown tool names returned by the model. |
| `question` | `AskUserQuestion` | n/a (handled via `question.*` events, NOT `permission.asked`) | no | Gated on `OPENCODE_CLIENT ∈ {app,cli,desktop}` or `OPENCODE_ENABLE_QUESTION_TOOL`. |
| `bash`/`shell` | `Bash` | `bash` permission keyed by parsed command arity | **yes** — only tool that mutates `state.metadata.output` during run | research/09 §6. |
| `read` | `Read` | filesystem read fence | no | LSP-aware; images/PDFs supported. |
| `glob` | `Glob` | none | no | Ripgrep-backed. |
| `grep` | `Grep` | none | no | Ripgrep-backed. |
| `edit` | `Edit` | `edit` permission per path | no | Disabled for `gpt-*` models in favor of `apply_patch`. |
| `write` | `Write` | `edit` permission | no | Same gpt-* swap. |
| `task` | `Agent` / `Skill` | `task` permission per agent | yes (sub-agent stream forwarded) | Runs a sub-session. |
| `webfetch` | `WebFetch` | network fence (`webfetch`) | no | |
| `todowrite` | `TodoWrite` | none | no | Same shape as Claude's `TodoWrite`. |
| `websearch` | `WebSearch` | gated to `providerID === opencode` or `OPENCODE_ENABLE_EXA` | no | Backed by Exa. |
| `skill` | `Skill` | n/a | no | Loads `.opencode/skills/<name>` bundle. |
| `apply_patch` | (none, gpt-* path) | `edit` permission | no | Mutually exclusive with `edit`/`write`. |
| `lsp` | `LSP` | none | no | `OPENCODE_EXPERIMENTAL_LSP_TOOL` only. |
| `plan` | `EnterPlanMode`/`ExitPlanMode` | none | no | `OPENCODE_EXPERIMENTAL_PLAN_MODE` + `OPENCODE_CLIENT==='cli'` only. |

**No analog**: Claude's `Agent` (TaskCreate), `TaskGet`, `TaskList`,
`TaskUpdate`, `TaskOutput`, `Monitor`, `Sleep`, `CronCreate`,
`CronDelete`, `CronList`, `RemoteTrigger`, `SendMessage`,
`EnterWorktree`, `ExitWorktree`, `ToolSearch`, `NotebookEdit`,
`ListMcpResourcesTool`, `ReadMcpResourceTool`. Most collapse into
`task` (sub-agent) or `skill`.

### MCP integration

| Aspect | OpenCode behavior |
|---|---|
| Tool source | MCP is a peer source, glued into the same registry. |
| Naming | `<sanitize(server)>_<sanitize(tool)>`. **No `mcp__` prefix** (different from Claude). |
| Approval | MCP tools default to `ctx.ask({ permission: key, patterns: ['*'], always: ['*'] })` — **always asked on first call**, regardless of agent ruleset (research/09 §3). Built-ins consult `Permission.evaluate`. |
| Transports | `local` (stdio), `remote` (Streamable HTTP), `remote` SSE (legacy fallback). |
| Auth | OAuth 2.1 with dynamic client registration (`mcp/oauth-provider.ts`). |
| Events | `mcp.tools.changed`, `mcp.browser.open.failed`. Status: `connected | disabled | failed | needs_auth | needs_client_registration` (`MCP.status()`). |
| Slash commands | MCP prompts become `/<server>_<prompt>` slash commands (`command/index.ts:118-145`). |

**The `needs_auth` status is a real gap vs. Claude/Codex** (research/09
§7). Recommendation: add a new `auth_required` event variant on
`channels/types.ts` (or `OpencodeHeadless` legacy event) in the same
PR. Existing packages can adopt it later (Claude's PR doesn't need it
because OAuth is opaque to the wrapper there).

### Plugin contract (`@opencode-ai/plugin`)

Plugins run **inside the server**, expose `Hooks` (`plugin/src/index.ts:222-333`):

| Hook | Shape | Effect on `opencode-headless` |
|---|---|---|
| `tool` | declarative tool definitions | Plugins add tools; we see them as `tool` parts. No special handling. |
| `auth` | provider login flows | Auth happens server-side; `opencode-headless` doesn't drive logins. |
| `provider` | dynamic model lists | We see resolved models on `Step.started`. |
| `event` | bus event fan-out | Plugins can publish their own events — surface as `unknownEvent` until we know the shape. |
| `chat.message/params/headers` | mutate user message | Invisible to us; user prompt-in / event-out semantics preserved. |
| `permission.ask` | override permission decision | Invisible — by the time we see `permission.asked`, plugin decisions have already filtered. |
| `tool.execute.before/after` | mutate tool args/result | Invisible; we see final args and final results. |
| `tool.definition` | mutate per-call description | Invisible. |
| `command.execute.before` | inject parts before slash-command | Surfaces as part events. |
| `shell.env` | mutate shell tool env | Invisible. |
| `experimental.*` | various | Surface as unknown events. |
| `experimental_workspace.register` | new workspace backend | Out of scope. |

The headline: **`opencode-headless` is plugin-transparent**. Plugins
extend the server; we consume the resulting events.

### `.opencode/tool/` and `.opencode/command/`

- `.opencode/tool/` — file-loaded tools with the same `ToolDefinition`
  shape as plugins. Surface identically.
- `.opencode/command/` — markdown-with-frontmatter slash commands.
  Fire `command.executed` on the bus when run. Surface as
  `CommittedEntryEvent` for parity with `/` commands in the other
  packages.

### Tool-use event shape on the wire

```ts
// One ToolPart goes through state transitions; each transition fires
// message.part.updated.

// On tool-input-start:
{ type: 'tool',
  id: 'prt_…', messageID: 'msg_…', sessionID: 'ses_…',
  tool: 'read',
  callID: 'call_…',
  state: { status: 'pending', input: {}, raw: '' } }

// On tool-call (input finalized):
{ /* same id */ state: { status: 'running',
                         input: { filePath: '/abs/path', limit: 200 },
                         time: { start: 1736870000000 } } }

// On tool-result:
{ /* same id */ state: { status: 'completed',
                         input: { … },
                         output: '<text>',
                         title: 'src/foo.ts',
                         metadata: { preview: '…', truncated: false },
                         time: { start: …, end: 1736870000123 } } }

// On tool-error:
{ /* same id */ state: { status: 'error',
                         error: '<message>',
                         time: { start: …, end: … } } }
```

Pairing key: `(sessionID, callID)`. The dispatcher's tool handling is:

```
state.status === 'pending'   → SemanticChannel.block_started(kind: tool_use)
state.status === 'running'   → no emission (block already started); tool_progress
                               if metadata.output mutated since last update
state.status === 'completed' → SemanticChannel.tool_result (isError: false)
                               + CommittedChannel.tool_result
state.status === 'error'     → SemanticChannel.tool_result (isError: true)
                               + CommittedChannel.tool_result
```

---

## 10. Concept mapping — three columns

| Concept | OpenCode | claude-code-headless | codex-headless |
|---|---|---|---|
| Live owner | always `server` | `proxy \| screen` (jsonl is durable, not live) | `proxy \| rollout \| screen` |
| Semantic source enum | `'proxy'` (= live wire), `'screen'` (unused) | `'proxy'`, `'jsonl'`, `'screen'` | `'proxy'`, `'rollout'`, `'screen'` |
| Transport | HTTP+SSE | PTY mirror + mitmproxy | PTY mirror + plain-HTTP proxy |
| Durable transcript | SQLite (`opencode.db`) | JSONL files | JSONL files |
| Transcript file path | n/a — query via HTTP | `~/.claude/projects/<sanitized-cwd>/<sid>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-…jsonl` |
| Project key derivation | `git rev-list --max-parents=0 HEAD` (first-parent SHA) | sanitized-cwd hash | n/a (sessions are global, filtered by `session_meta.cwd`) |
| Session id | `ses_<ULID>` | `<sessionId>.jsonl` filename | Codex rollout id from filename |
| Message id | `msg_<ULID>` | message uuid in JSONL | rollout entry uuid |
| Turn id | derived from step boundaries | `msg_<…>` from Anthropic API | rollout `task_started` event id |
| Block index | n/a (parts are flat, indexed by partID) | upstream `index` field from Anthropic SSE | rollout `block_index` (not stable across providers) |
| Part id | `prt_<ULID>` | n/a (Claude blocks have only index) | n/a |
| Tool call id | `callID` (= AI SDK toolCallId) | `tool_use_id` from Anthropic | `call_id` from OpenAI Responses |
| Tool input streaming | `tool-input-{start,delta,end}` typed | `input_json_delta` (raw JSON fragments) | n/a (Codex finalizes args server-side) |
| Tool result delivery | `state.status: completed` on the same `ToolPart` | next user-role JSONL entry's `tool_result` content block | rollout `function_call_output` entry |
| Approval surface | `permission.asked` SSE → `POST /reply` | TUI screen overlay → keystroke into PTY | TUI overlay + rollout `exec_approval_request` → conditions framework |
| Approval reply contract | `{ reply: 'once' \| 'always' \| 'reject', message? }` | `\r`, `2\r`, `3\r` keystrokes | `\r`, `p`, `\x1b` keystrokes |
| Trust dialog | unified with permission (`external_directory` permission axis) | first-run modal parsed by `TrustDialogParser` | first-run modal parsed by `TrustDialogParser` |
| Sandbox | none (no OS sandbox; cwd jail via `external_directory` permission) | none | none (`sandbox_policy` exists in `turn_context` but is not a real OS sandbox) |
| Compaction | first-class `CompactionPart` + `session.compacted` event | `compact_boundary` JSONL entries | rollout `compacted` payload |
| MCP tool naming | `<server>_<name>` (sanitized) | `mcp__<server>__<name>` | similar to Claude |
| MCP approval default | always-ask on first call | varies by tool | varies by tool |
| Resume | `GET /session/{id}/message` + `POST /sync/history` | tail JSONL from EOF; bootstrap-tail last-N for resume | tail rollout from EOF |
| Mid-stream attach | placeholder + live deltas (PartDelta is bus-only, lost on disconnect → `partAccumulator` mitigates) | live proxy + JSONL tail | byte-exact (rollout is live) |
| Abort path | `POST /session/{id}/abort` | `Esc` keystroke into PTY | `Esc` keystroke |
| Idle detection | `session.status: { type: 'idle' }` SSE event | screen-idle heuristic (debounce on spinner disappearance) | screen-idle heuristic |
| Activity verb | derived from `session.status` (`busy`/`compacting`/`retry`) | parsed from spinner regex on screen | parsed from `• Working (Ns • esc to interrupt)` pattern |
| Sidecar / aux-call filtering | server attributes its own calls (compaction, retry) and emits them as typed first-class events | `isSidecarFlow` request-shape predicates (Haiku, max_tokens<1024, etc.) | flow attribution state machine |
| Plugin system | first-class server-side hooks (`@opencode-ai/plugin`) | n/a | n/a |
| User questions (vs approvals) | `question.*` events — separate from `permission.*` | n/a (Claude has `AskUserQuestion` tool but no system-wide question gate) | n/a |
| Configuration injection | `OPENCODE_CONFIG_CONTENT=<json>` env | n/a — config tools side-channel | `--config k=v` CLI flags |
| Multi-client per session | yes (TUI + web + wrapper can coexist) | no | no |
| Auth | HTTP Basic (`OPENCODE_SERVER_PASSWORD`) | OAuth cached in `~/.claude/` | OAuth cached in `~/.codex/` |
| Workspace selection | per-request `x-opencode-directory` header | per-process cwd | per-process cwd |

### Concepts that don't map (gaps)

- **`signature_delta`** (Anthropic thinking signatures) — exists in
  Claude SSE, normalized away by the AI SDK in OpenCode (folds into
  `providerMetadata.anthropic.signature`). Loss of streaming
  granularity is unavoidable through OpenCode.
- **`citations_delta`** / **`connector_text_delta`** — same story.
- **Codex's `turn_context` with `approval_policy` + `sandbox_policy`** —
  OpenCode has no single "policy mode" dial. Closest is the per-tool
  `Action` shorthand in config, plus per-agent overrides.
- **Claude's tool registry** with `userFacingName`,
  `renderToolUseMessage`, `renderToolResultMessage` — OpenCode tools
  carry `title` and `metadata.preview` on the part state, but the
  rendering vocabulary is different. The renderer maps OpenCode
  conventions to Claude-style "header(args)" by reading `title` and
  `state.input`.
- **OpenCode's `task` sub-agent** — Claude has `Agent` (TaskCreate)
  with `Monitor`/`TaskOutput`/`TaskGet`/`TaskUpdate`/`TaskStop`;
  OpenCode has no async-task control surface. Sub-agent runs are
  in-process and their output flows back through the bus.
- **OpenCode's plugin hook system** — no analog. Plugins are
  invisible to consumers and we don't need to mirror them.
- **OpenCode's `pty` namespace** — server can host arbitrary PTYs for
  TUI/web use; not relevant to agent-code (which has its own
  terminal management).

---

## 11. Integration with `agent-code` — what the parent app needs

This section is for the implementation session that lands the wrapper
*and* wires it into the parent IDE. Specs only — no code mutation in
this research phase.

### Provider registries

| File | Change |
|---|---|
| `src/providers/registry.main.ts` | Add an entry for `opencode` alongside existing `claude` / `codex` entries. The factory function spawns `OpencodeHeadless` with the per-session cwd, sets `mode: 'spawn'` by default, returns the EventEmitter shape the registry expects. |
| `src/providers/registry.renderer.ts` | Add a renderer-side entry that knows how to mount workspace state for an OpenCode session. Mirrors how `claude` and `codex` entries do it today. |
| `src/providers/opencode/` (new) | New directory with `index.ts` (factory), `events.ts` (typed re-exports if needed), and any per-provider IDE glue (icon, display name, model picker shape). |
| `src/providers/shared/` | If a session-ownership type needs to expand to recognize OpenCode (probably yes), modify here. Audit needed during PR-1. |

### IPC channels

Most IPC is generic — the renderer subscribes to channel events and
the main process pumps them. Audit:

- `src/main/ipc/session.ts` and `src/main/ipc/sessions.ts` — verify
  they don't hard-code Claude/Codex assumptions (PTY ids,
  session-from-jsonl paths). If they do, generalize.
- `src/main/ipc/provider.ts` — provider switching. Already exists;
  add OpenCode to whatever discriminator it uses.
- New IPC needed: **`opencode:replyPermission`** — a renderer→main
  route to forward the user's approval reply to
  `OpencodeHeadless.replyToPermission`. The existing approval IPC may
  be generic enough; verify.
- New IPC needed: **`opencode:fetchHistory`** — for the renderer to
  request a cold snapshot from `HistoryClient` when reattaching to a
  session.
- `src/main/sessionManager.ts` — owns spawn lifecycle. Needs an
  `opencode` arm that creates an `OpencodeHeadless` instance instead
  of spawning a PTY. The branching here is the most invasive change.

### Renderer workspace glue

`src/renderer/src/workspace/` is the bulk of the renderer's
state-management. Audit:

- `workspace/runtime/` — runtime-state types per provider. Add an
  OpenCode arm.
- `workspace/semantic/foldEvent.ts` — the central reducer that takes
  semantic events and folds them into the feed. **Should work
  unchanged** because the SemanticChannel emits the existing event
  union. Test against a captured replay to confirm.
- `workspace/persistence.ts` — session persistence layer (for crash
  recovery). Needs to know how to re-acquire an OpenCode session on
  restart. Probably maps to `OpencodeHeadless({ mode: 'attach',
  serverUrl, sessionID })` — assumes the server is still running. If
  not, fall back to `spawn` + cold-snapshot replay.
- `workspace/sessionOwnership.ts` — owner discrimination. Already
  exists for cross-provider differentiation; add OpenCode.
- `workspace/spawn/` — provider-specific spawn helpers. Add an
  `opencode/` subdirectory.
- `workspace/conditions/` — Codex-specific currently. Stays
  Codex-specific; OpenCode uses `PermissionService` events directly,
  not conditions.
- `workspace/ghosts.ts` — see below.

### Ghost system implications

The ghost system (`docs/design/ghost-system.md`) exists *exactly
because* Claude has a proxy that's ahead of the JSONL writer by
~100ms and Codex's rollout-vs-screen race needed a reconciliation
layer. For OpenCode:

- The live SSE stream is the **same source** as the durable record
  (both come from the server's bus). There's no proxy-vs-jsonl gap.
- The only gap is `message.part.delta` (bus-only, ephemeral). The
  `partAccumulator` (§3) handles this client-side, *not* as ghosts —
  because the deltas reconcile against the eventual `message.part.updated`
  that arrives on the SAME stream within tens of milliseconds.

**Recommendation: ghosts do not fire for OpenCode sessions.** The
ghost reconciliation path in the renderer can short-circuit when the
provider is `opencode`. Add a comment in `workspace/ghosts.ts`
explaining why — future-you will go looking. Don't delete the ghost
machinery; Claude and Codex still need it.

### UI feature audits

| Feature | Status for OpenCode |
|---|---|
| Feed renderer (`features/feed/`) | Should work unchanged — same semantic events |
| Command palette `Switch Provider` (`features/command-palette/`) | Add OpenCode option |
| Spotlight | Add OpenCode session-create entry |
| Dispatch-pin (`features/dispatch-pin/`) | Verify it works without PTY ownership (see `dispatch_mode_planned` memory — Dispatch-to-native-terminal might mean running `opencode attach` as a child, separate from `OpencodeHeadless`) |
| Tile-tabs (`features/tile-tabs/`) | Should work — tiles host channels, not PTYs |
| Worktrees (`features/worktrees/`) | OpenCode's project-key-is-git-SHA means a worktree change might create a *different* project key. Verify session-list filtering works as expected |
| Editor (`features/editor/`, `features/global-editor/`) | Unchanged |
| Reader (`features/reader/`) | Should work — reads from CommittedChannel |
| Performance / system-perf | Unchanged |
| Settings (`features/settings/`) | Add OpenCode provider settings: password, server URL (for attach mode), config injection |
| Setup (`features/setup/`, `src/main/setup/`) | First-run: prompt for OpenCode binary path or skip if not installed; download the binary if requested; verify `opencode --version` |

### Settings / setup flow

OpenCode is an addon (per the user's framing — Claude and Codex
remain primary). The settings UI should:

1. Allow "Add OpenCode" as a toggle, default off.
2. When enabled, ask: spawn locally (auto-spawn `opencode serve`) or
   attach to a remote server URL.
3. If spawn: confirm binary path. Offer to download/install via `npm
   install -g opencode-ai` or the `script/install` recipe. Run `opencode
   --version` to verify.
4. Server password — generate randomly by default; allow override for
   remote-attach mode.
5. Provider credentials — OpenCode handles its own provider auth via
   the server's `/provider/{id}/oauth/*` endpoints. Surface these in
   settings via the SDK's `provider.list()` + per-provider auth
   flows.

### Things NOT to change in the parent codebase during PR-1

- Don't touch the ghost system. Just no-op for OpenCode sessions.
- Don't refactor `channels/types.ts` into a shared package yet
  (deferred to a follow-up).
- Don't add OpenCode-specific event types to the existing channels
  unless they're additive (the `auth_required` event needed for MCP
  is the only candidate, and it can land in PR-2).
- Don't add tests (`feedback_no_test_bloat` from memory).

---

## 12. Test strategy

### Spec only — no test files committed in the implementation PR

Per `feedback_no_test_bloat` in memory: implementation PRs ship
without new test files; cleanup PRs add tests separately. This section
documents what the test surface *should* look like when that cleanup
PR is written.

### `testing/record.ts`

Spawn `opencode serve` with a known `OPENCODE_CONFIG_CONTENT` blob,
construct `OpencodeHeadless({ mode: 'spawn', cwd, … })`, start it,
script a prompt sequence (e.g. "read this file, then edit it"), and
capture:

- Every SSE event byte-exact to `recordings/<name>/raw.events.jsonl`
- Every channel emission to `recordings/<name>/channels.jsonl`
- Final state (idle time, total turns, tool calls)

### `testing/replay.ts`

Read `recordings/<name>/raw.events.jsonl`, fan into a fresh
`EventDispatcher` with mock channels, dump the resulting channel
emissions. Diff against `recordings/<name>/channels.jsonl`. This is
the regression harness: a change to the dispatcher that breaks an
event-mapping invariant fails the replay.

### `testing/verify.ts`

Runs `replay` for every recording in `recordings/`. Property checks:

- Every `turn_started` has a matching `turn_completed` (no leaks).
- `partAccumulator` state at the end of every recording is empty
  (every in-flight part resolved).
- No `lifecycle_violation` events fired.
- Every `tool_input_finalized` has a corresponding `tool_result` (no
  hung tool calls).
- For recordings with mid-stream disconnects (injected by the test
  harness), `partAccumulator` reconciles correctly against the
  cold-snapshot recovery.

### Integration tests (live server)

A separate `testing/integration.ts` that requires a real `opencode
serve` and exercises:

- Spawn-and-attach lifecycle.
- Send-prompt → wait-idle → committed-channel-has-final.
- Permission flow: ask, reply `once`, ask again, reply `always`,
  third ask auto-resolved.
- Reconnect after killing the SSE socket (simulate network drop).
- Multi-client: two `OpencodeHeadless` instances on the same session,
  one replies to permission, other's resolver gets
  `AlreadyRespondedError`.

These are skipped by default (`SKIP_INTEGRATION=1`) and run in CI
with a real binary.

### Cross-package contract tests

Once `channels/types.ts` is extracted into a shared package, write
contract tests that exercise the same channel event union against all
three packages' mocked stream emitters. The renderer's
`workspace/semantic/foldEvent.ts` should produce equivalent feed
state when fed equivalent semantic events from any provider.

---

## 13. Open questions before implementation

> Grouped by urgency. "Must resolve before code" means PR-1 stalls
> until the question is answered. "Resolve during code" means the
> implementation can start with a default assumption and re-decide if
> empirical evidence points elsewhere. "Defer" means PR-2 or later.

### Must resolve before code

1. **Pin one of `OPENCODE_EXPERIMENTAL_HTTPAPI` (Hono vs effect-httpapi
   backend).** Research/01 §"Notable env vars" and research/02 §"Gaps"
   flag this. The v2 `session.next.*` event family flows on the
   effect-httpapi backend; whether it flows on Hono is unverified.
   *Experiment*: `OPENCODE_EXPERIMENTAL_HTTPAPI=1 opencode serve &; curl
   http://localhost:4096/event` while sending prompts via v1 path —
   does `session.next.text.delta` fire? Then with the flag off. Pick
   the backend that gives us the events we want, OR set the flag
   ourselves in `SpawnedServer.ts` env injection.

2. **Choose v1 vs v2 prompt endpoint.** Research/02 §"Gaps". The
   default proposal is v2 (`POST /api/session/{id}/prompt`) for the
   richer `session.next.*` events. But v2 is flagged experimental and
   may change. Decision: pick one, pin the SDK version, document the
   tradeoff. Alternative: support both via the `apiVersion` option and
   let agent-code's settings switch — but that doubles the dispatcher
   surface in §5.

3. **Confirm `POST /sync/history` is available in default installs.**
   Research/06 §"Open questions" #1 — `EventTable` writes are gated on
   `OPENCODE_EXPERIMENTAL_WORKSPACES`. If the default installs don't
   persist history rows, `/sync/history` returns empty and we MUST
   fall back to cold-snapshot-only on every reconnect. The fallback is
   already in `HistoryClient` (§3), but the question is what we do
   when the user's session is large and the cold snapshot is slow.
   *Experiment*: clean install, check default flag values.

4. **PartDelta buffer ceiling and eviction policy.** Research/06
   §"Mid-stream reattach" leaves this open. Proposed default: 1 MiB
   per part, 64 active parts, LRU. **Validate empirically** by
   recording a long tool-output session and watching `partAccumulator`
   memory. If 1 MiB is too tight, raise it. If 64 active parts is
   never approached in real sessions, drop the limit.

### Resolve during code

5. **`signature` field name in `providerMetadata`** for Anthropic
   thinking. Research/05 §"Open questions" #1. Probe at first
   integration test against a real Claude provider; fall back to
   "don't emit signature events" if the field name is unstable.

6. **`tool-input-delta` reach the bus?** Research/05 §"Open questions"
   #2 and research/09 §"Gaps" #2. If yes, we can stream tool args
   live; if no, we one-shot at `tool_input_finalized`. Default
   assumption: no (the processor ignores them). Confirm via integration
   test.

7. **`session.next.*` for v1-created sessions.** Research/02 §"Gaps".
   If yes, v2 prompts aren't required to receive v2 events, just to
   call the v2 endpoint. If no, then `apiVersion: 'v2'` is mandatory
   for live deltas. Falls out of experiment #1.

8. **Whether to depend on `@opencode-ai/sdk/v2` or vendor the 250
   LOC.** SDK dependency means: tracking their release cadence,
   inheriting their breaking changes, but getting type-safety
   generated from the same OpenAPI spec the server emits. Vendoring
   means: total control, no version coupling, but reimplementing for
   every OpenCode minor. **Recommendation: depend, pin major**.
   Decide at PR-1 import time.

9. **Project-key fallback for non-git directories.** OpenCode uses
   `git rev-list --max-parents=0 HEAD`; what does it do in a
   non-git cwd? Research/06 doesn't cover. Probably has a hash-the-cwd
   fallback like Claude. Confirm by checking
   `packages/opencode/src/project/project.ts` more carefully.

10. **MCP `needs_auth` event surface.** Research/09 §7 flags this as a
    real gap vs Claude/Codex. The proposal in §3 / §5.18 is to add an
    `auth_required` event to the channel surface. Decide whether this
    lands in PR-1 or PR-2.

11. **`tool_progress` semantic variant.** Research/09 §6 — only `shell`
    has streaming progress via `state.metadata.output`. Either add a
    new `tool_progress` semantic event variant (§5.4 row for
    `session.next.tool.progress`), or coerce it into a series of
    `tool_input_delta` events with a synthetic `inputJsonSoFar`. The
    former is cleaner.

12. **`question.*` event handling.** Research/09 mentions
    `QuestionTool`. The proposal in §5.13 is a `question_requested`
    event on `ScreenChannel` or `OpencodeHeadless` legacy events. The
    renderer needs UI for it; defer the channel-type decision until
    we know what UI shape the renderer wants.

### Defer to v2

13. **TUI driving via `/tui/*` endpoints.** Research/03 §"v1 namespaces"
    notes the SDK can drive an already-running TUI. Out of scope for
    `opencode-headless` v1; could be useful for a future
    Dispatch-to-native-terminal integration where agent-code pops the
    real `opencode attach` TUI in a host terminal and remote-drives
    it. Defer.

14. **`pty.*` namespace.** Research/02 §"Streaming/long-lived" — the
    server can host arbitrary PTYs. Agent-code already has its own
    terminal management; out of scope.

15. **Multi-workspace per server.** Research/02 §"Lifecycle" — one
    server can serve many workspaces via the
    `x-opencode-directory` header. Per-instance currently we just
    pin one cwd. Future: a single `SpawnedServer` shared across
    multiple `OpencodeHeadless` instances, each with its own cwd.
    Defer.

16. **Plugin event surface forwarding.** Plugin-emitted bus events
    arrive as opaque `unknownEvent`. A future PR could let consumers
    register typed schemas for known plugin events. Defer.

17. **`share`/`export`/`import` endpoints.** Out of scope for
    headless wrapping.

18. **`acp` mode (Agent Client Protocol over stdin/stdout).** An
    alternative wire if HTTP+SSE turns out to be wrong shape.
    Documented in research/01 as a fallback. Defer.

19. **Cross-channel `channels/types.ts` extraction.** Move to a shared
    `packages/headless-shared/` package. Important for long-term
    maintenance but not blocking PR-1.

---

## 14. Recommended PR sequence

### PR-1: minimum viable

> One PR, coupled per `feedback_avoid_enforcement_bloat`. No splits,
> no scaffolding.

**Lands:**

- `packages/opencode-headless/` skeleton with all files from §3,
  including the WHY-comments inline.
- `src/OpencodeHeadless.ts` — full constructor, `start`, `stop`,
  `sendPrompt`, `abort`, `replyToPermission`, channel accessors.
  Hard-coded to v2 endpoint (per question #2 resolution).
- `src/transport/` — `SpawnedServer`, `SseClient`, `SyncClient`. Depend
  on `@opencode-ai/sdk/v2` (per question #8 resolution).
- `src/dispatcher/EventDispatcher.ts` — handles every event in §5
  except the ones marked "Resolve during code" (which become `TODO:
  pending question N` comments).
- `src/dispatcher/partAccumulator.ts` and `turnTracker.ts`.
- `src/channels/` — all three channels, duplicated `types.ts` from
  claude-code-headless with a top-comment marking the canonical source.
- `src/permissions/` — full `PermissionService` with race guards.
- `src/transcript/` — `TranscriptTypes`, `ProjectKey`, `SessionList`,
  `HistoryClient` with cold-snapshot path implemented; `/sync/history`
  path stubbed with a fallback comment.
- `EVENT_SPEC.md` — extracted from §5 of this proposal.
- `PROXY_STREAMING.md` — one-line stub redirecting to `EVENT_SPEC.md`.
- agent-code wiring: `src/providers/registry.main.ts` + `.renderer.ts`
  entries, `src/main/sessionManager.ts` arm, `workspace/runtime/`
  glue, `workspace/persistence.ts` re-acquire path,
  `workspace/sessionOwnership.ts` discriminator, settings UI for
  enable/disable + server config.

**Out:**

- Tests (deferred per memory).
- `tool_progress` semantic variant (question #11) — for v1 we coerce
  via metadata-update-as-tool_input_delta hack.
- MCP `auth_required` (question #10) — for v1, surface MCP needs-auth
  as a generic toast.
- Test recordings.
- `channels/types.ts` extraction to shared package.

**PR size**: probably ~1500 LOC across the wrapper + ~300 LOC across
agent-code wiring. Single PR.

### PR-2: parity polish

- `tool_progress` semantic variant (with consumers in
  `workspace/semantic/foldEvent.ts`).
- MCP `auth_required` event variant + renderer surface.
- `question.*` event surface + renderer UI.
- `POST /sync/history` path proven against a real
  `OPENCODE_EXPERIMENTAL_WORKSPACES=1` install.
- Buffer-overflow event handling in renderer (`partAccumulator.overflow`
  → "message truncated, refresh" UI).

### PR-3: tests

- Move `channels/types.ts` to a shared `packages/headless-shared/`
  package; update all three wrappers to depend on it.
- Land `testing/{record,replay,verify}.ts` with at least 3 recordings
  exercising the dispatcher: simple text-only turn, tool-heavy turn
  with approvals, mid-stream reconnect.
- CI integration via the existing per-test:* scripts (one for
  `test:opencode-replay`).

### PR-N: nothing

No more after PR-3 — the package is feature-complete for v1 and the
acceptance criterion was "agent-code drives OpenCode the same way it
drives Claude and Codex." Future work happens as small targeted PRs
against specific findings.

---

## 15. Style and conventions checklist

For the engineer (or future-self) opening the implementation session.
Don't skip these — they're how the package stays consistent with the
rest of the repo.

- [ ] **Worktree workflow.** Branch work goes in `.worktrees/<name>`;
      main checkout stays on `main`. From memory:
      `feedback_worktree_default`.
- [ ] **Thick WHY comments per `CLAUDE.md`.** Every load-bearing file
      gets a top-comment explaining why it exists, what constraint
      forced its shape, what invariants hold, what tried-and-failed
      alternatives there were. Specifically:
  - `EventDispatcher.ts` reproduces the §5 mapping table in comments.
  - `partAccumulator.ts` quotes the research/06 finding about
    `message.part.delta` being bus-only.
  - `OpencodeHeadless.ts` quotes the spawn-vs-attach rationale.
  - `HistoryClient.ts` reproduces the 4-step reattach recipe.
  - `PermissionService.ts` cites
    `packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx:190,440`
    as proof the TUI uses the same call we do.
- [ ] **Don't auto-merge PRs.** Open the PR and stop. From memory:
      `feedback_no_auto_merge`.
- [ ] **Use merge commits, not squash.** `gh pr merge --merge`. From
      memory: `feedback_merge_style`.
- [ ] **GitHub account for PRs.** cc-shell is on Juliusolsson05;
      switch before any `gh pr` command. From memory:
      `reference_gh_account`. (Note: this memory references cc-shell;
      agent-code may use the same account — verify before pushing.)
- [ ] **No new tests in feature PRs.** Tests land in cleanup PR-3.
      From memory: `feedback_no_test_bloat`.
- [ ] **No enforcement / scaffolding bloat.** No CI grep locks, no
      multi-PR splits for coupled work, no YAGNI guards. API +
      migrations + thick WHY comments and stop. From memory:
      `feedback_avoid_enforcement_bloat`.
- [ ] **No length caps on planning artifacts.** This proposal is long
      on purpose; future spec/research docs should be too. From
      memory: `feedback_no_length_caps_on_specs`.
- [ ] **Re-read load-bearing research files before coding the matched
      modules:**
  - Before `EventDispatcher.ts`: re-read `research/02-server-and-wire-protocol.md`
    and `research/05-provider-abstraction.md`.
  - Before `HistoryClient.ts` and `partAccumulator.ts`: re-read
    `research/06-session-persistence-and-resume.md`.
  - Before `PermissionService.ts`: re-read
    `research/08-approval-and-permissions.md`.
  - Before `SpawnedServer.ts`: re-read `research/01-process-and-cli.md`
    §"SDK already does the spawn dance".
- [ ] **Channel symmetry.** Even though `ScreenChannel` is mostly inert
      for OpenCode, keep the class. Downstream IDE code is provider-
      agnostic and switches on channel kind. Forking that code path
      is the failure mode.
- [ ] **Don't touch existing packages.** No edits to
      `packages/claude-code-headless/` or `packages/codex-headless/`
      in PR-1 even if you notice cleanups. Note them and defer.
- [ ] **No emoji.** Anywhere. Per repo convention.

---

> End of architecture proposal. Total length: deliberately long. If
> the implementation session needs more context than this provides,
> the gap is a research bug — open a follow-up before writing code.
