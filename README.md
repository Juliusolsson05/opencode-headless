# opencode-headless

Programmatic OpenCode control through OpenCode's structured server API.

This package is intentionally **not** a terminal wrapper. Claude Code and
Codex need PTY/screen support because parts of their useful state are exposed
through terminal UI behavior. OpenCode already exposes the useful state through
`opencode serve`: HTTP endpoints for commands/history/permissions and an SSE
bus for live events.

## What it does

- starts `opencode serve`, or attaches to an existing server URL
- subscribes to `/event`
- creates and prompts sessions through HTTP
- replies to structured permission requests
- publishes the same three conceptual channels as the other headless packages:
  - `semantic` - live model/tool activity
  - `screen` - synthetic visible/overlay state such as activity and permissions
  - `committed` - durable session history fetched from OpenCode
- emits every raw OpenCode SSE bus envelope on the top-level `raw` event

## What it does not do

- no OpenCode TUI
- no PTY attachment
- no terminal screen scraping
- no provider-wire parsing
- no JSONL tailing

## Basic usage

```ts
import { OpencodeHeadless } from 'opencode-headless'

const oc = new OpencodeHeadless({
  cwd: process.cwd(),
})

oc.semantic.on('turn_delta', ev => {
  process.stdout.write(ev.textDelta ?? '')
})

oc.screen.on('permission', ev => {
  console.log('permission requested', ev.state.requestID)
})

oc.on('raw', ev => {
  console.debug('opencode event', ev.type)
})

await oc.start()
await oc.prompt({ prompt: 'Summarize this repository.' })
```

Attach mode:

```ts
const oc = new OpencodeHeadless({
  mode: 'attach',
  serverUrl: 'http://127.0.0.1:4096',
  cwd: process.cwd(),
})
```

Permission reply:

```ts
oc.on('permission', async req => {
  await oc.permissionService.approveOnce(req.requestID)
})
```

## Authentication

Spawn mode runs the real `opencode serve` binary as the current OS user and
inherits `process.env` by default. That means provider credentials created by
`opencode providers` / `opencode auth` in the user's terminal are reused by the
headless server, the same way they are reused when the user launches OpenCode
manually.

Packaged hosts should avoid launching with a stripped environment. If they need
to add variables, pass only the additions through `env`; the server launcher
merges them over `process.env` instead of replacing the user's login context.

Set `pure: true` to pass `opencode serve --pure`. This keeps provider auth and
normal OpenCode storage, but disables external plugins. Agent Code integration
will usually want this unless it explicitly wants the user's plugin layer to
participate in every headless run.

## Implementation notes

The first implementation uses direct `fetch` calls instead of depending on
`@opencode-ai/sdk/v2`. That keeps this package isolated while the exact
OpenCode version is still being validated. The HTTP paths are centralized in
`src/transport/SyncClient.ts`, so moving to the generated SDK later should be a
small mechanical change.

## Live harness

The temporary `testing/` folder contains an agentic harness that runs against a
real local OpenCode install and the current user's provider auth:

```sh
npm --prefix packages/opencode-headless run test:live
```

It covers server startup/auth, prompt streaming, attach mode, multi-turn
follow-up, permission service paths, committed history, and a realistic
HTML/CSS file-edit task in
`/Users/juliusolsson/Desktop/Development/testing/opencode-work`.
