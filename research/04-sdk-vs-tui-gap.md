# SDK vs TUI gap — opencode-headless

## Verdict: **SDK-only is sufficient.** No PTY-wrap. No screen parsing.

OpenCode is a **server-first** product whose own TUI is just one of N possible
clients of the same HTTP/SSE API the SDK exposes. The TUI does not have any
private channel to the agent core. Every dialog, every spinner, every approval
overlay is built by `useSDK()` calls and `useEvent()` subscriptions to the
exact `/event` SSE stream `@opencode-ai/sdk/v2` already gives you. The most
load-bearing single piece of evidence: `packages/opencode/src/cli/cmd/tui/attach.ts:10-48`
exists — the *same* TUI binary will attach over HTTP+basic-auth to a remote
`opencode serve` and reproduce the entire experience purely from SDK calls.
PTY-wrapping a TUI that is itself a thin remote client would be a strict loss
(extra IPC layer, no actual extra signal) versus calling the same endpoints
directly.

This is the polar opposite of `claude` and `codex`, where the CLI is the agent
runtime and the SDK is a curated subset. For OpenCode, **the agent runtime is
the server**, and the TUI/SDK are siblings looking at the same bus.

The body lays out every TUI affordance from the Claude/Codex parser checklist
(`packages/claude-code-headless/src/parsers/`,
`packages/codex-headless/src/parsers|conditions/`) and where to get the same
signal from the SDK.

## Architecture observation that reframes the question

Three files together kill the manifesto question:

1. `packages/opencode/src/server/event.ts:39-87` — the `/event` SSE endpoint
   is a flat firehose of `Bus.subscribeAll()`. Whatever the TUI sees, an SDK
   client sees byte-for-byte.
2. `packages/opencode/src/cli/cmd/tui/context/sync.tsx:36-322` — the TUI's
   entire state store (`session`, `message`, `part`, `permission`, `question`,
   `todo`, `mcp`, `lsp`, `session_status`, `session_diff`, `vcs`, ...) is
   bootstrapped from SDK list endpoints and incrementally maintained from
   the same SSE bus. The TUI has no source of truth the SDK lacks.
3. `packages/opencode/src/cli/cmd/tui/attach.ts:10-48` — the TUI is itself
   a remote-attachable SDK client. Authoritative.

Combined with the SDK enumerating ~106 endpoints (`grep 'url: "/'
sdk/js/src/v2/gen/types.gen.ts | sort -u | wc -l` → 106) including
`/permission/{requestID}/reply`, `/question/{requestID}/reply`,
`/session/{sessionID}/abort`, `/session/{sessionID}/compact`,
`/session/{sessionID}/fork`, `/session/{sessionID}/revert`, plus
`/tui/append-prompt`, `/tui/execute-command`, etc., there is no UX action
the TUI can perform that the SDK can't drive.

## Gap table — TUI behaviors mapped against SDK exposure

| Capability | TUI location | SDK exposure? | Severity | Notes |
|---|---|---|---|---|
| Permission/approval overlay | `tui/routes/session/permission.tsx:134-461` | **Yes**: `permission.asked`/`replied` events + `POST /permission/{id}/reply` | none | Whole dialog is `sdk.client.permission.reply(...)` |
| Question (interactive choice) tool overlay | `tui/routes/session/question.tsx:13-78` | **Yes**: `question.asked`/`replied`/`rejected` + `POST /question/{id}/{reply,reject}` | none | Same shape as permission |
| Slash-command picker | `tui/component/dialog-command.tsx:1-130`; ~27 registrations across `app.tsx`, `routes/session/index.tsx`, `prompt/index.tsx` | **Partial**: server publishes `/command` (user-defined) and `tui.command.execute` events, but built-in slashes (`/share`, `/rename`, `/timeline`, `/fork`, `/compact`, `/unshare`, `/undo`, `/redo`, `/timestamps`, `/thinking`, `/copy`, `/export`, `/sessions`, `/new`, `/models`, `/agents`, `/mcps`, `/variants`, `/connect`, `/status`, `/themes`, `/help`, `/exit`, `/editor`, `/skills`, `/warp`) are **TUI-side compositions** of multiple SDK calls | degraded | Each slash is implemented in TSX as a tiny script over the SDK. To replicate "type `/compact` in opencode-headless and have it work", we either (a) let our renderer do the same composition or (b) call `POST /tui/execute-command` against an attached TUI. (b) only works if we PTY-wrap. (a) is one switch statement. Verdict: re-implement the small set we expose; not a blocker. |
| Spinner verbs ("Writing command...", "Running shell...") | per-tool TSX: `tui/routes/session/index.tsx:1788-1853` (Shell), 1855+ (Write/Edit) etc. | **No** as text, **yes** as data: `Part.state.status` ∈ `pending|running|completed|error` and `Part.state.metadata.output` are SDK fields | cosmetic | The strings are TUI-local copy. Our renderer chooses its own copy. |
| Compaction banner | `session/index.tsx` plus the `/compact` slash | **Yes**: `session.compacted` event + `POST /session/{id}/compact`; per-message tokens carry `compacted` (`types.gen.ts:583`); SessionStatus surfaces `next.compaction.started.1` aggregate event | none | We get the lifecycle exactly. |
| Resume prompt / "continue last session" | `attach.ts:24-37` (`--continue`, `--session`); `validate-session.ts:1-24` | **Yes**: `sdk.client.session.get({sessionID})` plus `session.list({start:..., scope:...})` | none | Trivial. No interactive prompt — user picks via session list dialog or `--session`. |
| Session list dialog | `tui/component/dialog-session-list.tsx` | **Yes**: `GET /session?search=...` | none | Pure SDK. |
| Mode badges (build vs plan agent) | `routes/session/index.tsx:227-241` flips `local.agent` on `plan_enter`/`plan_exit` tool completion | **Yes**: `message.part.updated` event with `tool.tool === "plan_enter"|"plan_exit"` is on the bus | degraded | We reimplement the same 8-line switch. |
| Theme/state in status row (LSP count, MCP count, permissions count, /status hint) | `routes/session/footer.tsx:9-91` | **Yes**: `lsp.diagnostics`, MCP `tools.changed`, `permission.asked`/`replied` and stored counts in sync store | none | Every count is derived from SDK state. |
| Expanded vs collapsed thinking | `routes/session/index.tsx:161,646-651` (`/thinking` slash) | **Yes** as data: `reasoning` parts (`types.gen.ts:485,2036-2070`) flow on `message.part.updated` and `session.next.reasoning.{started,delta,ended}` | cosmetic | Visibility toggle is renderer-local. |
| Tool-output truncation cues ("Click to expand", "…") | per-tool TSX, e.g. `index.tsx:1614-1646` (GenericTool), 1788-1853 (Shell) | **No** as cues, **yes** as data: full output is in `Part.state.metadata.output` / `Part.state.output` | cosmetic | Renderer choice. |
| Multi-line input affordances, file `@`-completion, paste placeholders, frecency | `tui/component/prompt/{index,autocomplete,frecency}.tsx` | **N/A**: pure renderer concern; backed by `GET /find/file`, `GET /file/content`. The TUI's prompt parts (`type:"file"|"agent"|"text"`) are a wire format documented in SDK types | none | The `parts` array is the SDK contract for `session.prompt`. We send the same JSON. |
| Toast notifications | TUI local + `tui.toast.show` event (`tui/event.ts:36-46`) | **Yes** — `tui.toast.show` is on the bus and in the SDK type union | degraded | Other clients (ours) get the toast as data and decide how to render. Server-side plugins/hooks publish toasts via `POST /tui/show-toast`. |
| Provider/model picker, OAuth login dance | `tui/component/dialog-{provider,model}.tsx`; `dialog-provider.tsx:84-117` | **Yes**: `POST /provider/{id}/oauth/authorize` returns `{method:"code","auto"}` payload; `POST /provider/{id}/oauth/callback`; account login is its own CLI (`cli/cmd/account.ts:39-62`) using device-code flow against console | none | The provider dialog **is** an SDK consumer. We can drive the same flow. The only login-from-CLI step is `opencode account login <url>` for the OpenCode account itself, which prints a URL/code and polls — it's a separate side-channel orthogonal to per-session work. |
| Currently selected provider/model | `tui/context/local.tsx`; sent per-prompt as `model` arg | **N/A**: server is stateless about "current model". Caller must track. | degraded (by design) | Same model the existing two packages handle in their channel state. Not a bug, a contract. |
| Pending-approval queue | `routes/session/index.tsx:138-147,1666-1670` derived from `sync.data.permission` | **Yes**: replay every `permission.asked`/`replied` to derive count | none | Trivial. |
| Queued user input while agent is working | `tui/component/prompt/index.tsx:117,648-651` — local `stashed` variable kept in module scope | **No** | cosmetic | Not server state at all. UX choice in our renderer. |
| Retry banners / rate-limit hints | `session/status.ts:10-26` defines `{type:"retry", attempt, message, next}`; emitted on `session.status` | **Yes** | none | Better than Claude/Codex — explicit typed status. |
| `go-upsell` dialog on retry-with-magic-message | `routes/session/index.tsx:257-272` | **Yes**: same `session.status` event | cosmetic | Renderer choice whether to show. |
| Context-window warnings | `tui/component/prompt/index.tsx:314-331` computes `pct = tokens/model.limit.context`; TUI shows it inline | **Yes**: `AssistantMessage.tokens.{input,output,reasoning,cache.read,cache.write}` and `Provider.models[id].limit.context` are SDK fields | none | Pure SDK derivation. |
| Trust dialog (allow folder) | `routes/session/permission.tsx:354-380` `external_directory` permission | **Yes**: it IS a permission, same flow as any other tool approval | none | Important: OpenCode unifies what Claude calls "trust" and Codex calls "approval" into one `permission.asked` channel. |
| Workspace warp / fork timeline / undo / redo | various dialogs in `routes/session/`; `tui/routes/session/dialog-{timeline,fork-from-timeline}.tsx` | **Yes**: `/session/{id}/{fork,revert,unrevert}`, `/experimental/workspace/*` | none | Pure SDK. |
| MCP browser-open-failed banners | `mcp/index.ts:57` `BrowserOpenFailed` bus event | **Yes** | none | |
| `installation.update_available` nudge | `installation/index.ts:23-35` | **Yes** | cosmetic | Polish. |
| Heartbeat / connection liveness | `server/event.ts:52-60` 10s `server.heartbeat`; `server.connected` initial event | **Yes** | none | We need to honor it; same as our existing SSE handlers. |

## What we *would* lose by SDK-only — the honest accounting

1. **Built-in slash command catalog isn't a server enum.** Each TUI slash is a
   composition of SDK calls written in TSX. We have to re-implement the small
   set we want to expose (or treat the user's `/foo` as raw text and let the
   server route only user-defined commands via `/session/{id}/command`). This
   is degraded UX, not lost capability — and trivial to recreate. We won't
   want all 27 anyway (e.g. `/themes`, `/help`, `/exit` are TUI chrome).
2. **Spinner copy / collapse-toggle UX.** The TUI's "Writing command...",
   "Click to expand" affordances are renderer literals. If we want pixel
   parity we'd type the same strings; otherwise our renderer picks its own.
   Cosmetic.
3. **Frecency-ranked file mentions, prompt history, prompt stash.** These
   are local TUI state (`tui/component/prompt/{frecency,history,stash}.tsx`),
   not server state. SDK-only loses none of this because none of it lives
   server-side; agent-code already has its own input affordances anyway.
4. **The model the user "feels like they're on".** SDK requires you to send
   `model:{providerID, modelID}` per prompt. The "currently selected" notion
   is purely a TUI store. Not a gap — a contract.

None of these is **blocking**. None of them justifies a PTY wrap; PTY-wrapping
a Solid+opentui app would also be brittle (no stable text grid markers, no
ANSI overlays we could parse — it's a real GPU-style render tree).

## What this means for the channel model

The agent-code channel taxonomy
(`SemanticChannel` / `ScreenChannel` / `CommittedChannel`) collapses for
OpenCode:

- **SemanticChannel** = the SSE `/event` stream, source `server`. There is
  no proxy/jsonl/screen split because OpenCode owns its own provider layer
  and writes its own durable storage; the live event stream IS the canonical
  semantic source.
- **ScreenChannel** = empty. There is no TUI chrome we'd parse because we
  aren't running the TUI. (If a future user really wants to embed the TUI,
  they can `attach.ts` it themselves outside `opencode-headless`'s scope —
  see issue tracker for "Dispatch-to-native-terminal mode".)
- **CommittedChannel** = SDK list/get endpoints (`/session`, `/session/{id}/message`,
  `/message/{id}/part/{partID}`) plus `/sync/replay` for catchup.

Live-owner state machine simplifies to "the server is always the live owner".
There's no proxy vs jsonl vs screen race to mediate.

## Recommendation for the synthesis agent

Build `opencode-headless` as a **thin SDK transport adapter**:

1. Spawn `opencode serve` (or accept an existing URL).
2. Call `@opencode-ai/sdk/v2` for actions; subscribe `/event` for state.
3. Project bus events into the existing channel API surface so consumers
   (agent-code) don't need to know OpenCode is special.
4. Drop `parsers/Screen*.ts`, `terminal/`, `proxy/sseFraming` for this
   package — none have an analog. Keep the channel/event interface so the
   IDE doesn't care which provider is mounted.
5. Re-implement the ~5 slash commands we actually want (`/compact`, `/fork`,
   `/undo`, `/redo`, `/share`) as small composition functions that call the
   SDK; treat unknown `/foo` as user-defined commands routed to
   `/session/{id}/command`.
