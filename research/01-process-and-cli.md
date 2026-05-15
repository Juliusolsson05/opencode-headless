# 01 — Process & CLI invocation

## Punchline

`opencode` is a **single multi-command yargs CLI** whose default subcommand is
the TUI but which already ships a first-class `serve` subcommand that prints
`opencode server listening on http://<host>:<port>` and then blocks forever.
The official JS SDK (`@opencode-ai/sdk`) consumes that exact mode by spawning
`opencode serve` with `cross-spawn`, parsing the listen-line off stdout, and
talking HTTP — **no PTY, no xterm mirror, no proxy**. Internally even the TUI
itself runs the server in a Bun `Worker` and talks to it via an in-process
fetch bridge. There is no daemon, no fork-into-the-background, no socket file:
each invocation is one foreground process, with the choice of TUI-front or
HTTP-only made by the subcommand.

For `opencode-headless` this means the consumer-owned `IPty` contract used by
`packages/claude-code-headless/src/ClaudeCodeHeadless.ts:1` and
`packages/codex-headless/src/CodexHeadless.ts:1` does not fit — those packages
take an `IPty` because the only way to drive `claude` / `codex` is to puppet
their TUI. `opencode` exposes the same surface as a documented HTTP/SSE
server, so the natural shape is `child_process` (or even no process at all
when bundled in-process) plus an HTTP/SSE client. Whether we still need the
TUI for capability parity is agent 04's question; the *invocation* answer is
unambiguous.

## Entry point

| Layer | Path | Role |
|---|---|---|
| Shipped binary stub | `packages/opencode/bin/opencode` | Node shim that re-execs the platform-specific compiled Bun binary |
| Override | env `OPENCODE_BIN_PATH` | If set, stub `exec`s that path verbatim — the only sanctioned way to point at a non-installed build (`packages/opencode/bin/opencode:20-23`) |
| Resolution | `node_modules/opencode-{darwin,linux,windows}-{x64,arm64}[-baseline][-musl]/bin/opencode` | Walks up from the stub looking for the matching native package; on x64 sniffs AVX2 to pick `baseline` vs full (`packages/opencode/bin/opencode:34-167`) |
| Dev source entry | `packages/opencode/src/index.ts:1` | yargs CLI; what `bun run --cwd packages/opencode src/index.ts` runs |

The stub is `stdio: "inherit"`, no buffering, exit-code passthrough — so any
caller that already knows where the real binary lives is better off skipping
the shim and either running it directly or setting `OPENCODE_BIN_PATH`.

## Subcommands (modes)

Registered in `packages/opencode/src/index.ts:157-179`. The default is the
TUI: `TuiThreadCommand` is registered with `command: "$0 [project]"`
(`packages/opencode/src/cli/cmd/tui/thread.ts:81`), so bare `opencode` opens
the TUI in `$PWD`.

| Subcommand | Source | Purpose | Long-lived? | Useful to a headless host? |
|---|---|---|---|---|
| *(default)* / `$0 [project]` | `cli/cmd/tui/thread.ts:81` | Spawn TUI **and** an in-process server (Bun Worker) | yes | no — TUI is opentui-driven |
| `serve` | `cli/cmd/serve.ts:7` | Headless HTTP/SSE server, blocks on `Effect.never` | yes | **yes — primary target** |
| `web` | `cli/cmd/web.ts:32` | Same as `serve` + opens browser to bundled web UI | yes | maybe — same server |
| `attach <url>` | `cli/cmd/tui/attach.ts:10` | Attach a *local* TUI process to a remote `serve` instance | yes | no, but proves TUI↔server is decoupled |
| `run [message..]` | `cli/cmd/run.ts:206` | One-shot: spawn in-process server (or `--attach`) and stream a single prompt | per-prompt | yes — the existing one-shot reference |
| `acp` | `cli/cmd/acp.ts:13` | Speak Agent Client Protocol over stdin/stdout (ndjson) | yes | yes — alternative wire if HTTP/SSE is wrong shape |
| `mcp` | `cli/cmd/mcp.ts` | Run as an MCP server | yes | tangential |
| `agent`, `models`, `providers`, `session`, `db`, `mcp`, `plug`, `github`, `pr`, `export`, `import`, `stats`, `debug`, `generate`, `upgrade`, `uninstall`, `account` | `cli/cmd/*.ts` | One-shot management commands | no | no |

The same flags appear on `tui` (default), `serve`, `web` and `acp` because
they all go through `cli/network.ts:6-32`: `--port` (default `0` → server
prefers 4096 then any-free; see `server/server.ts:293-298`), `--hostname`
(default `127.0.0.1`), `--mdns`, `--mdns-domain`, `--cors` (repeatable).
`run`/`attach` add `--password`/`-p`, `--username`/`-u`, `--dir`,
`--continue`/`-c`, `--session`/`-s`, `--fork`, `--model`/`-m`, `--agent`,
`--share`, `--variant`, `--thinking`, `--format default|json`, and
`--dangerously-skip-permissions` (full list in
`cli/cmd/run.ts:215-305`).

Global flags applied by the top-level middleware
(`packages/opencode/src/index.ts:77-89`): `--print-logs`, `--log-level
DEBUG|INFO|WARN|ERROR`, `--pure` (sets `OPENCODE_PURE=1`, disables external
plugins).

## Process model

There is **no daemon**. Every subcommand is a foreground Node/Bun process
that exits when the subcommand handler returns or `process.exit()` is called
(`packages/opencode/src/index.ts:241-247` forces exit so stuck child
subprocesses can't hang us). The interesting structure:

- `serve` and `web` call `Server.listen(opts)` and then `yield* Effect.never`
  (`cli/cmd/serve.ts:18-22`, `cli/cmd/web.ts:43-83`). They print exactly one
  line — `opencode server listening on http://<hostname>:<port>` — to stdout
  before blocking. That line is the SDK's handshake.
- `run` skips spawning a child for the in-process path: it builds a virtual
  `fetch` against `Server.Default().app.fetch` and hands that to
  `createOpencodeClient` with `baseUrl: "http://opencode.internal"`
  (`cli/cmd/run.ts:670-675`). When `--attach` is set, it instead points the
  SDK at the remote URL and uses `ServerAuth.headers()`
  (`cli/cmd/run.ts:664-668`).
- The default TUI (`cli/cmd/tui/thread.ts:147-212`) spawns a Bun
  `Worker(./worker.ts)`, the worker calls `Server.listen()` on demand
  (`cli/cmd/tui/worker.ts:48-78`), and the parent talks to it through an
  RPC-bridged `fetch` plus an `EventSource` impl that proxies global bus
  events. Only when `--port`/`--hostname`/`--mdns` is explicit (or non-loopback)
  does it expose the worker's server externally.

Translation: the server is a library (`Server.Default()` /
`Server.listen()`), and every visible subcommand is a different way to mount
it — same code path either way.

## SDK already does the spawn dance

`packages/sdk/js/src/v2/server.ts:22-100` is `createOpencodeServer({ hostname,
port, timeout, config, signal })`. It runs `cross-spawn("opencode", ["serve",
"--hostname=…", "--port=…"])`, scans stdout for the literal prefix
`"opencode server listening"`, parses the URL out of the rest of the line,
and resolves `{ url, close() }`. Config can be injected without touching the
filesystem via the env var `OPENCODE_CONFIG_CONTENT` (a JSON blob — see
`config/config.ts:582-590`). `createOpencode()` in
`packages/sdk/js/src/v2/index.ts` then pairs the spawned server with
`createOpencodeClient({ baseUrl: server.url })`. This is the off-the-shelf
shape `opencode-headless` should adopt or wrap.

## Configuration & on-disk state

Search order for project config — files merged on top of global, last write
wins, arrays concatenated (`config/config.ts:482-580`):

1. `<XDG_CONFIG_HOME>/opencode/config.json`, then `…/opencode.json`, then
   `…/opencode.jsonc` (global; `Global.Path.config` from
   `packages/core/src/global.ts:11-29`).
2. `OPENCODE_CONFIG=<file>` if set (`Flag.OPENCODE_CONFIG`,
   `core/src/flag/flag.ts:38`).
3. Project: walk up from `cwd` collecting `opencode.json` /`opencode.jsonc`
   files, and from each `.opencode/` directory collect the same pair
   (`config/paths.ts:10-41`, `config/config.ts:518-547`). Walk stops at
   `worktree`. `OPENCODE_DISABLE_PROJECT_CONFIG=1` skips this.
4. `~/.opencode/opencode.json[c]` (home-directory fallback).
5. `OPENCODE_CONFIG_DIR=<dir>` if set, scanned for the same two files
   (`flag.ts:108-110`).
6. `OPENCODE_CONFIG_CONTENT=<json>` env-injected blob (`config/config.ts:582`).
7. macOS managed `.mobileconfig` (MDM) — wins everything.

Per-instance `.opencode/` layout observed in this checkout
(`vendor/in_progress/opencode/.opencode/`): `opencode.jsonc`, `agent/`,
`command/`, `glossary/`, `plugins/`, `skills/`, `tool/`, `themes/`,
`tui.json`, plus `env.d.ts`. TUI-only keys belong in `tui.json` —
`config/config.ts:60-66` warns when `theme`/`keybinds`/`tui` appear in the
main config.

XDG-derived disk locations (`packages/core/src/global.ts:9-27`, all under
`opencode`): `data` (`$XDG_DATA_HOME`, holds `opencode.db` and the
`json-migration` marker — `packages/opencode/src/index.ts:118`), `config`
(`$XDG_CONFIG_HOME`), `state`, `cache`, `bin` (`cache/bin`), `log`
(`data/log`), `tmp` (`os.tmpdir()/opencode`). The `data` dir is the durable
session/transcript root — agent 06's territory.

Notable env vars beyond config
(`packages/core/src/flag/flag.ts:31-120`): `OPENCODE_SERVER_PASSWORD` /
`OPENCODE_SERVER_USERNAME` (Basic auth; `serve` warns if password unset —
`cli/cmd/serve.ts:15`; helper at `server/auth.ts:36-48`),
`OPENCODE_EXPERIMENTAL_HTTPAPI` (swap legacy Hono backend for new
effect-httpapi backend — `flag.ts:94`, `server/server.ts:61-77`),
`OPENCODE_WORKSPACE_ID` (single-workspace mode — `server/server.ts:118`),
`OPENCODE_PURE`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_TUI_CONFIG`,
`OPENCODE_CLIENT` (defaults to `cli`; `acp` sets it to `acp`), `AGENT=1` and
`OPENCODE=1` set unconditionally on startup
(`packages/opencode/src/index.ts:107-109`).

## Cross-reference vs `claude` and `codex`

| Aspect | `claude` (claude-code-headless) | `codex` (codex-headless) | `opencode` |
|---|---|---|---|
| Live semantic source | mitmproxy on `api.anthropic.com` (TLS intercept) | plain HTTP via `--config openai_base_url=` override | **first-party HTTP/SSE on the binary itself** (`serve`/`event.subscribe`) |
| Output channel | TUI screen (xterm parse) + JSONL tail | TUI screen + rollout JSONL (live) | server events; TUI is just another consumer |
| Wrap shape | consumer-owned `IPty` to TUI | consumer-owned `IPty` to TUI | spawn `opencode serve`, parse listen-line, hit HTTP |
| Daemon? | no (TUI process is the lifetime) | no (TUI process is the lifetime) | no — but `serve` is a long-lived foreground server |
| Multiple clients per instance? | no | no | yes — `attach <url>` exists |
| Auth between client and binary | n/a (same process) | n/a | Basic auth via `OPENCODE_SERVER_PASSWORD` / `--password` |
| Config injection without disk | env vars | `--config k=v` flags | `OPENCODE_CONFIG_CONTENT=<json>` env |

## Implications for `opencode-headless`

1. **The PTY is optional.** Everything `serve` does is reachable via HTTP and
   SSE/WebSocket. The existing `IPty`-as-input contract should be replaced
   (or supplemented) by a `child_process.spawn("opencode", ["serve", …])`
   handle plus an HTTP/SSE client. Whether the channel model still holds is
   an implementation question for agent 10; the transport question is
   answered.
2. **Don't reimplement the spawn dance.** `@opencode-ai/sdk`
   (`packages/sdk/js/src/v2/server.ts:22`) already spawns and awaits the
   listen-line. Either depend on it or copy its 80-line shape verbatim — the
   listen-prefix `"opencode server listening on "` is the only contract we
   need.
3. **Config injection without a file** is `OPENCODE_CONFIG_CONTENT=<json>`.
   That removes the temp-`.opencode/` workaround the other two packages
   never needed but we'd otherwise reach for.
4. **Auth must be wired.** `serve` is unauthenticated by default and prints
   a warning. A headless host should always set
   `OPENCODE_SERVER_PASSWORD` and pass `Authorization: Basic …` headers
   (helpers at `server/auth.ts:36-48`).
5. **Listen-port edge case.** `--port 0` inside the effect-httpapi backend
   tries 4096 first, then a random free port (`server/server.ts:293-298`).
   Consumers must read the URL from the listen-line, not assume 4096.

## Gaps / things I did not verify

- I did not run the binary; the listen-line format and exit semantics are
  inferred from source and the SDK parser only.
- `--mdns` Bonjour publish/unpublish lifetime under repeated `serve` restarts:
  unverified.
- Whether `OPENCODE_CONFIG_CONTENT` survives a TUI Worker spawn in all
  channels: not checked end-to-end. Unknown — would need to instrument.
- Concurrency: nothing in the source forbids two `opencode serve` processes
  on different ports sharing one `XDG_DATA_HOME`, but I did not verify file
  locking on `opencode.db` beyond noting `Flock.setGlobal` in
  `packages/core/src/global.ts:31`. Agent 06 will care.
- The `effect-httpapi` vs legacy-`hono` backend split
  (`server/server.ts:61-77`, `flag.ts:94`) is real and channel-gated; we
  should pin one for our tests, but I have not picked which.
