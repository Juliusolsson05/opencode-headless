# 07 — TUI & screen-parseable surface

## TL;DR — lead with the punchline

**`opencode-headless` should not have a `parsers/` or `terminal/` layer at
all.** Every signal that the existing two packages reverse-engineer out of
xterm screen buffers is delivered to OpenCode's own TUI as typed events
over the server's HTTP/SSE bus. The TUI is a thin, stateless renderer of
those events; there is no "TUI-only" semantic content to recover. If we
PTY-wrap and screen-parse, we reinvent a wheel that the SDK already gives
us first-class — exactly the inverse of the Claude/Codex situation.

The Claude/Codex parser tax exists because those CLIs are TUI-first and
the SDK is a partial reflection of the TUI. OpenCode is server-first and
the TUI is a partial reflection of the SDK. The asymmetry is total.

## Does a TUI binary exist?

Yes. It's the same `opencode` Bun binary, dispatched via subcommands:

| Command | Behavior | Source |
|---|---|---|
| `opencode attach <url>` | Connects the TUI to a running server (local or remote) | `vendor/in_progress/opencode/packages/opencode/src/cli/cmd/tui/attach.ts:10-48` |
| `opencode tui-thread …` | Spawns a server in-process and immediately attaches | `…/src/cli/cmd/tui/thread.ts` (registered in `…/src/index.ts:26,159`) |
| `opencode serve` | Headless server only, no TUI | `…/src/cli/cmd/serve.ts` |
| `opencode run` | One-shot prompt, prints model output to stdout, no TUI | `…/src/cli/cmd/run.ts` |

Both TUI entrypoints route through `tui()` in
`vendor/in_progress/opencode/packages/opencode/src/cli/cmd/tui/app.tsx`.

## What renders the TUI?

**OpenTUI + SolidJS** — a buffer-mode terminal renderer (analogous to
Bubble Tea or Ratatui, *not* Ink). Confirmed by:

- `package.json` deps: `@opentui/core`, `@opentui/solid`,
  `opentui-spinner`
  (`vendor/in_progress/opencode/packages/opencode/package.json`).
- `app.tsx:1` imports `render`, `useKeyboard`, `useRenderer`,
  `useTerminalDimensions` from `@opentui/solid`.
- `app.tsx:3` imports `createCliRenderer`, `MouseButton` from
  `@opentui/core`.
- `app.tsx:71-89` configures the renderer with
  `externalOutputMode: "passthrough"`, kitty keyboard protocol,
  `useMouse: true`, custom palette negotiation
  (`renderer.getPalette({ size: 16 })`,
  `renderer.waitForThemeMode(1000)`).
- Components are JSX over SolidJS primitives like `<box>`, `<text>`,
  `<scrollbox>`, `<spinner>`, `<Portal>`
  (e.g.
  `…/cli/cmd/tui/component/spinner.tsx`,
  `…/cli/cmd/tui/routes/session/permission.tsx:tail`).

This is the same architectural class as Codex's Ratatui frontend: a
double-buffered framebuffer rendered into the alternate screen, with
diff-driven repaints. **Screen-scraping such a renderer is essentially
hopeless** — there are no stable text markers because cells are addressed
by `(row, col, fg, bg, attrs)` and the layout reflows on every resize.

## How does the TUI get its data?

`vendor/in_progress/opencode/packages/opencode/src/cli/cmd/tui/context/sdk.tsx:1-80`
shows the entire data path:

```ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
…
function startSSE() { … sdk.event.subscribe(…) … }
```

The TUI is a **pure consumer** of the same `@opencode-ai/sdk/v2` SSE
stream that any other client would consume. Every store update routes
through `batch(() => emitter.emit("event", event))`. That means
`opencode-headless` can subscribe to the *exact same* `GlobalEvent`
stream and get strictly more data than any screen parser could ever
recover (typed payloads, IDs, timestamps, deltas).

## Parser-equivalence catalog

For each parser the existing two packages ship, here's the OpenCode
equivalent — and why we don't write it.

| Existing parser | What it solves for claude/codex | OpenCode source of truth | Implication for opencode-headless |
|---|---|---|---|
| `ScreenParser` (Claude `⏺` / Codex `•` bullets) | Per-turn assistant text recovery from xterm cells | SSE `message.part.updated` with `part.type === "text"` parts on `AssistantMessage` (typed via `@opencode-ai/sdk/v2`); rendered in `routes/session/index.tsx` via the typed `Part` discriminator | **None.** No bullet, no extraction. SemanticChannel sources directly from SSE. |
| `extractAssistantInProgress()` (lookback for last `⏺` block) | Live partial-turn assistant text | Same — SSE delivers append-only `text` parts with stable `partID` | **None.** "In-progress turn" = the most recent `AssistantMessage` whose `time.completed` is null. |
| `PermissionPromptParser` (Claude) / `ApprovalParser` (Codex) | Detect/parse the modal asking "Allow / Deny / Always allow" from screen | `routes/session/permission.tsx` renders a `PermissionRequest` from `@opencode-ai/sdk/v2`; the request itself arrives as a typed SSE event and is resolved via an HTTP endpoint | **None.** Agent 08 covers the wire shape. The TUI's permission overlay has zero unique state. |
| `TrustDialogParser` (both) | First-run "do you trust this folder?" prompt | **No equivalent.** OpenCode's `attach <url>` uses `ServerAuth.headers({ password, username })` (`attach.ts:69`) — auth is provider/server-side, not a TUI consent dialog. `cli/cmd/account.ts` handles login non-modally. | **Drop entirely.** |
| `CompactionParser` (Claude) | Detect "compacting conversation…" banner | Bus event `session.compact` (`cli/cmd/tui/event.ts:19`) plus session-level events on the SDK SSE stream | **None.** Subscribe to bus events. |
| `ResumePromptParser` (Claude) | Detect the "resume previous session?" picker | Driven by `attach --continue`/`--session` flags resolved before the renderer mounts (`attach.ts:24-37,72-78`); session listing dialog is `component/dialog-session-list.tsx`, populated from `sdk.session.list()` not from screen text | **None.** Pre-renderer flow; session list is data-driven. |
| `SlashPickerParser` (Claude) | Detect `/command` autocomplete picker | `component/dialog-command.tsx` + `component/prompt/autocomplete.tsx` — fully TUI-internal, no consumer needs to know it's open | **Drop.** Slash commands are issued by the TUI's own keyboard handlers; the consumer sees the *result* event, not the picker. |
| `LineDiff` | Frame-to-frame diff for cheap screen-change detection | N/A — there is no screen to diff | **Drop.** |

### Other dialogs / overlays that exist but don't need parsers

`component/dialog-{agent,model,provider,mcp,status,theme-list,session-list,session-rename,session-delete-failed,skill,stash,tag,workspace-create,workspace-unavailable,go-upsell,variant,console-org}.tsx`
plus `ui/dialog-{alert,confirm,export-options,help,prompt,select}.tsx`.
Every one of these is rendered locally from data the TUI already has via
the SDK; none expose state the headless consumer doesn't already see in
the SSE stream. They are renderer-internal.

## Activity / spinner indicator

`component/spinner.tsx` renders the braille frames
`["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]` on an 80 ms tick. **Don't
parse this.** The semantic equivalent is the live state of the active
`AssistantMessage` on the SSE stream — when there is one and its
`time.completed` is null, the model is working; when a `tool` part is
the most recent and pending, that tool is running. That's the *real*
"verb" line, and it's structured.

(Compare Claude's `WorkingLine` regex matching `\b(Hatching|Pondering|…)
[\d.]+s` on screen — that exists only because Claude doesn't expose the
verb via its API.)

## Per-turn assistant marker

There is no `⏺`/`•` analog and there does not need to be one. The
correct boundary is the `AssistantMessage` envelope from the SDK; parts
within it carry stable `partID`s. `extractAssistantInProgress` becomes a
trivial one-liner: take the parts of the last `AssistantMessage` whose
`time.completed === null`.

## Divergences worth flagging to agent 10

1. **No `terminal/HeadlessTerminal` reuse.** Both existing packages
   import the same xterm wrapper. opencode-headless skips it.
2. **No proxy/mitmproxy.** Provider HTTP traffic is irrelevant; the
   server already publishes the normalized event. Agent 02/05 cover
   this in detail.
3. **`ScreenChannel` may collapse to a no-op or be removed entirely.**
   The three-channel model (`SemanticChannel`, `ScreenChannel`,
   `CommittedChannel`) was designed around screen being a third
   independent source. For OpenCode, "screen" has no semantic content
   the SDK doesn't already provide. Either delete `ScreenChannel`, or
   keep the type as an empty channel for API symmetry across the three
   packages (the latter is probably less disruptive for downstream
   IDE consumers that switch on channel kind).
4. **Dispatch-to-native-terminal mode (per MEMORY.md) still works.** If
   we want a "pop the real `opencode attach` TUI into a host terminal"
   escape hatch, we just spawn `opencode attach <url>` as a child
   process; the headless package itself never needs to see the screen.

## Gaps / unknowns

- I did not enumerate every plugin route under `feature-plugins/` —
  these can register custom dialogs, but they too consume the same
  event bus, so the conclusion holds.
- I have not verified the SSE event names against agent 02's findings.
  If a permission/compaction event turns out to lack a critical field,
  we'd recover it via the typed SDK call — never via screen scraping.
