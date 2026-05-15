# Research brief — opencode-headless

> Read this whole file before starting your assigned topic. It tells you
> *why* we're researching OpenCode, *what shape the existing two packages
> have* (so your findings frame against them), and the *hard rules* every
> agent must follow.

## Why we're doing this

`agent-code` is an Electron desktop IDE that drives the **real** `claude`
and `codex` CLIs headlessly under PTYs. The thesis is that wrappers which
bypass the real CLI (OAuth-token reuse, reduced SDK surface, "send message
get message back") throw away ~75% of what makes those tools good. So
agent-code instead runs the actual binaries and parses their TUI / SSE /
transcript output.

Two packages already exist that establish the pattern:

- `packages/claude-code-headless/` — drives `claude` via PTY + xterm
  mirror, taps Anthropic's SSE via mitmproxy for the live semantic stream,
  tails `~/.claude/projects/<sanitized-cwd>/<sid>.jsonl` for durable
  history.
- `packages/codex-headless/` — same shape for `codex`, but with two
  differences worth knowing up front: (a) Codex's rollout JSONL is a
  **live** semantic source (not write-on-complete like Claude's), and
  (b) the proxy is plain HTTP because Codex has a native
  `--config openai_base_url=` override, no TLS interception needed.

Both packages expose three channels — `SemanticChannel` (model output,
sources `proxy | jsonl/rollout | screen`), `ScreenChannel` (TUI chrome /
overlays / activity), `CommittedChannel` (durable transcript) — with a
strict live-owner state machine that prevents proxy / jsonl / screen from
fighting over the visible turn.

We now want the same thing for OpenCode, as an **addon** (not primary)
provider.

## The fundamental open question

OpenCode is architecturally different. It's a Bun monorepo with what looks
like a **server-first** design — there's a `packages/core`, a
`packages/web`, a `packages/desktop`, AND an `sdks/` folder with a
published VSCode SDK. That suggests OpenCode may already expose a clean
HTTP/SSE server surface that `opencode-headless` can consume *directly*,
without the PTY-wrap + mitmproxy + screen-parse machinery the other two
packages need.

If that's true, `opencode-headless` becomes a thin transport adapter and
the channel model still holds — but huge swathes of the existing-package
machinery (`terminal/`, `parsers/Screen*`, `proxy/sseFraming`) probably
don't need to exist for OpenCode.

If it's *not* true — if the SDK loses too much of what the actual TUI
does, the same way SDK-only wrappers of Claude/Codex lose 75% — then we
have to PTY-wrap and parse like the other two packages.

**Agent 04 is investigating exactly that gap. Most other agents will
inform that decision.**

## Ground truth locations

| Source | Path |
|---|---|
| OpenCode source (vendor) | `/Users/juliusolsson/Desktop/Development/agent-code/vendor/in_progress/opencode/` |
| OpenCode official site (use WebFetch) | https://opencode.ai |
| Existing claude package (mirror) | `/Users/juliusolsson/Desktop/Development/agent-code/packages/claude-code-headless/` |
| Existing codex package (mirror) | `/Users/juliusolsson/Desktop/Development/agent-code/packages/codex-headless/` |
| Existing claude EVENT_SPEC | `/Users/juliusolsson/Desktop/Development/agent-code/packages/claude-code-headless/EVENT_SPEC.md` |
| Existing claude PROXY_STREAMING | `/Users/juliusolsson/Desktop/Development/agent-code/packages/claude-code-headless/PROXY_STREAMING.md` |
| Project conventions | `/Users/juliusolsson/Desktop/Development/agent-code/CLAUDE.md`, `/Users/juliusolsson/Desktop/Development/agent-code/MANIFESTO.md` |

## File ownership (do NOT collide)

Each agent owns exactly one file. Write only that file.

| Agent | File | Topic |
|---|---|---|
| 01 | `research/01-process-and-cli.md` | invocation, CLI, daemon vs TUI vs headless modes, config |
| 02 | `research/02-server-and-wire-protocol.md` | HTTP/SSE server, endpoint surface, event stream |
| 03 | `research/03-existing-sdks.md` | what `sdks/` exposes; official surface |
| 04 | `research/04-sdk-vs-tui-gap.md` | **what the actual TUI does that the SDK doesn't expose** — the manifesto question |
| 05 | `research/05-provider-abstraction.md` | how Anthropic/OpenAI/etc. are normalized inside OpenCode |
| 06 | `research/06-session-persistence-and-resume.md` | on-disk schema, append-live vs write-on-complete, reattach contract |
| 07 | `research/07-tui-and-screen-surface.md` | TUI markers/chrome/overlays we'd parse — or "n/a, server-driven" with evidence |
| 08 | `research/08-approval-and-permissions.md` | tool-approval flow, events, contract |
| 09 | `research/09-tools-mcp-plugins.md` | tool registry, MCP, `.opencode/plugins/`, tool_use/tool_result event shape |
| 10 | `research/10-architecture-proposal.md` | **synthesis — runs after 1-9.** Reads the other nine, proposes module layout, mapping table to claude/codex equivalents. |

## Hard rules — every agent

1. **Write ONLY your assigned file.** Not the brief, not other research
   files, not `package.json`, not the README, not anything outside
   `packages/opencode-headless/research/`.
2. **No `git commit`, `git add`, `git push`, `git stash`.** Read-only git
   commands (`git log`, `git status`, `git show`) are fine.
3. **Do not modify `vendor/`, `src/`, the existing `packages/claude-code-headless/`
   or `packages/codex-headless/`, or any config file.** The vendor copy
   of OpenCode is read-only.
4. **Cite file paths with line numbers** like the existing packages do —
   `packages/core/src/foo.ts:123` — not vague references.
5. **Read the existing two packages** so your terminology matches
   (channels, semantic source, live owner, etc.). If your topic doesn't
   map cleanly to those concepts, say so explicitly — don't invent new
   vocabulary.
6. **If you can't answer something from the codebase, say so.** "Unknown,
   would need to instrument and observe" is a valid finding. Do not
   guess.
7. **Length: ~800-1500 words in the .md file.** Quality over quantity.
   No padding, no filler section that just restates the brief.
8. **Report back to your dispatcher in <150 words**: filename written,
   3-bullet TL;DR, important questions/gaps. The deliverable is the .md
   file on disk; your reply is a pointer.

## Style notes

- Match the tone of `packages/claude-code-headless/EVENT_SPEC.md` and
  `packages/claude-code-headless/PROXY_STREAMING.md` — terse, technical,
  source-anchored, opinionated where the source forces an opinion.
- Tables for enumerations, fenced blocks for code/JSON, no emoji.
- When you discover something surprising, lead with it. Don't bury the
  punchline under setup.
- When the existing two packages do something one way and OpenCode forces
  a different way, *call out the divergence* — that's the most useful
  signal for the synthesis agent and for the implementation session that
  follows.

Good luck. The synthesis agent (10) is reading what you write.
