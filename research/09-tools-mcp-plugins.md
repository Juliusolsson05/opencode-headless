# Tools, MCP, and plugins

> The headline finding: OpenCode tools are first-class **server-side
> Effect services**, not strings emitted by a TUI. The model's tool
> call → execution → result round-trip happens entirely inside the
> OpenCode server process and is broadcast as `message.part.updated`
> events with a discriminated `ToolPart.state` ∈ `{pending, running,
> completed, error}`. **There is no rendered tool block to scrape**;
> consumers re-render from the part state. This is the same shape Claude
> and Codex expose in their JSONL transcripts, but here it ships *live*
> over the SSE bus — closer to Codex's rollout than Claude's
> write-on-complete pattern.

## 1. Built-in tool catalog

Source of truth: `packages/opencode/src/tool/registry.ts:196-234`. The
order in `builtin[]` is the order tools are advertised to the LLM.

| ID            | Class                | Streaming progress | Approval gate              | Notes |
|---------------|----------------------|--------------------|----------------------------|-------|
| `invalid`     | `InvalidTool`        | n/a                | n/a                        | Sentinel for unknown tool names returned by the model. |
| `question`    | `QuestionTool`       | no                 | n/a                        | Conditional on `OPENCODE_CLIENT ∈ {app,cli,desktop}` or `OPENCODE_ENABLE_QUESTION_TOOL` (`registry.ts:193-194,219`). |
| `bash`/`shell`| `ShellTool`          | **yes** (`ctx.metadata` chunked stdout, `shell.ts:446-503`) | `bash` permission keyed by parsed command arity (`shell/prompt.ts`) |
| `read`        | `ReadTool`           | no                 | filesystem read fence       | LSP-aware; supports image/PDF attachments (`tool/read.ts`). |
| `glob`        | `GlobTool`           | no                 | none                        | Ripgrep-backed file discovery. |
| `grep`        | `GrepTool`           | no                 | none                        | Ripgrep-backed content search. |
| `edit`        | `EditTool`           | no                 | `edit` permission per-path  | Disabled when `gpt-*` (non-`oss`, non-`gpt-4`) → `apply_patch` swap (`registry.ts:290-294`). |
| `write`       | `WriteTool`          | no                 | `edit` permission           | Same swap rule as `edit`. |
| `task`        | `TaskTool`           | yes (subagent stream forwarded) | `task` permission per-agent (`registry.ts:269-282`) | Runs a non-`primary` Agent as a sub-session. |
| `webfetch`    | `WebFetchTool`       | no                 | network fence               | |
| `todowrite`   | `TodoWriteTool`      | no                 | none                        | Todo store mirrors Claude's `TodoWrite`. |
| `websearch`   | `WebSearchTool`      | no                 | gated to `providerID === opencode` or `OPENCODE_ENABLE_EXA` (`registry.ts:286-288`) | Backed by Exa via the OpenCode-hosted provider. |
| `skill`       | `SkillTool`          | no                 | n/a                         | Loads a `.opencode/skills/<name>` bundle. |
| `apply_patch` | `ApplyPatchTool`     | no                 | `edit` permission           | gpt-* path; mutually exclusive with `edit`/`write`. |
| `lsp`         | `LspTool`            | no                 | none                        | `OPENCODE_EXPERIMENTAL_LSP_TOOL` only. |
| `plan`        | `PlanExitTool`       | no                 | none                        | `OPENCODE_EXPERIMENTAL_PLAN_MODE` + `OPENCODE_CLIENT === "cli"` only. |

Compared to Claude's catalog (claude-code-headless `EVENT_SPEC.md:170-191`),
OpenCode is **smaller and flatter**. There is no `Agent`/`Skill`/`TaskCreate`/
`TaskList`/`TaskUpdate`/`TaskOutput`/`Monitor`/`Sleep`/`CronCreate`/
`CronDelete`/`CronList`/`RemoteTrigger`/`SendMessage`/`EnterPlanMode`/
`ExitPlanMode`/`AskUserQuestion`/`ToolSearch`/`NotebookEdit`/
`ListMcpResourcesTool`/`ReadMcpResourceTool` — most of those collapse into
either `task` (sub-agent), `skill`, `plan`, `question`, or are simply not
implemented. There is no `mcp__<server>__<tool>` virtual namespace; MCP
tools surface under `<sanitized-server>_<sanitized-name>` (see §3 below).

## 2. Custom tools — `.opencode/tool/`

`registry.ts:170-183` glob-loads `{tool,tools}/*.{js,ts}` from every
config directory and dynamic-imports each as a `file://` URL. Every
exported `ToolDefinition` becomes a tool whose ID is `<basename>` for
the `default` export and `<basename>_<exportName>` otherwise. The
contract is `packages/plugin/src/tool.ts` — a plain Zod-shape object:

```ts
export default tool({
  description: "…",
  args: { query: tool.schema.string(), limit: tool.schema.number().default(10) },
  async execute(args, ctx) { return "string-or-{output,metadata}" },
})
```

`ctx` is `PluginToolContext` (`registry.ts:135-145`) — `sessionID`,
`messageID`, `agent`, `directory`, `worktree`, `abort`, `metadata()`,
`ask()` for permission. Plugin tools share the same truncation and
schema-validation pipeline as built-ins (`registry.ts:147-156`). The
project's own `.opencode/opencode.jsonc` shows tools can be **toggled
off per-project** via `tools: { "github-triage": false }`.

## 3. MCP integration

`packages/opencode/src/mcp/index.ts`. MCP is "just another tool source"
glued into the same registry surface. Three transports:

| Transport            | Config shape                                              | Auth                              |
|----------------------|-----------------------------------------------------------|-----------------------------------|
| `local` (stdio)      | `{ type: "local", command: [...], environment, timeout }` | env-only (`mcp/index.ts:385-418`) |
| `remote` Streamable HTTP | `{ type: "remote", url, headers, oauth?, timeout }`   | OAuth 2.1 + dynamic client registration (`mcp/oauth-provider.ts`) |
| `remote` SSE (legacy)| Same as above; tried after Streamable HTTP fails          | Same OAuth provider               |

Config lives at `cfg.mcp[name]` and is parsed by `config/mcp.ts`. Each
named server is `connectRemote`/`connectLocal` → returns an MCP `Client`
that stays open for the session. `MCP.tools()` (`mcp/index.ts:630-663`)
lists each server's tools and **renames them to
`<sanitize(server)>_<sanitize(toolName)>`** before merging into the AI
SDK tool map in `session/prompt.ts:458-549`. Names are *not* prefixed
with `mcp__`; the only signal that a tool is MCP-backed is membership in
that map (vs. the registry's `all()` list) — and the per-call permission
gate in `session/prompt.ts:475` (`ctx.ask({ permission: key,
patterns: ["*"], always: ["*"] })`) which is **always asked** on first
call, regardless of the agent's permission ruleset. That divergence
matters: built-in tools consult `Permission.evaluate` against the agent
ruleset; MCP tools default to "ask once".

OAuth flow surfaces three bus events the consumer must handle:
`mcp.tools.changed` (server pushed a `notifications/tools/list_changed`),
`mcp.browser.open.failed` (system `open` failed → present URL manually),
plus the toast `MCP Authentication Required` (`mcp/index.ts:340-357`).
A `Status` discriminated union (`connected | disabled | failed |
needs_auth | needs_client_registration`) is exposed via
`MCP.status()` for surface rendering.

MCP also contributes **prompts** and **resources**. Prompts are
re-published as slash commands (`source: "mcp"`, `command/index.ts:118-145`),
which is how MCP servers can ship `/<server>_<prompt>` entries.

## 4. Plugin contract (`@opencode-ai/plugin`)

`packages/plugin/src/index.ts`. A plugin is `(input, options) =>
Promise<Hooks>`. `input` carries an embedded `OpencodeClient` bound to
`http://localhost:4096` — plugins run inside the server and call **back
into the same server** through the same SDK consumers use. Loadable from
npm via `cfg.plugin_origins[]`, or via `.opencode/plugins/*.{ts,tsx,
json}` (the project's `tui-smoke.tsx` is a routes-and-slots TUI plugin).

`Hooks` (full list, `plugin/src/index.ts:222-333`):

| Hook                                     | Shape                                       | Purpose |
|------------------------------------------|---------------------------------------------|---------|
| `tool: { [name]: ToolDefinition }`       | declarative                                 | Adds custom tools, same shape as `.opencode/tool/`. |
| `auth: AuthHook`                         | `{ provider, methods: [...], loader? }`    | Adds an OAuth/API-key login flow for a provider (this is how Codex/Copilot/GitLab/Poe/Cloudflare/Azure auth ship — `INTERNAL_PLUGINS` array, `plugin/index.ts:59-67`). |
| `provider: ProviderHook`                 | `{ id, models? }`                           | Dynamic model list for a provider. |
| `event({ event })`                       | fan-out                                     | Receives **every** bus event (`plugin/index.ts:243-251`). |
| `config(cfg)`                            | one-shot                                    | Notified on load with the resolved config. |
| `chat.message`, `chat.params`, `chat.headers` | `(input, output)` mutator                | Modify the user message, sampling params, or HTTP headers before send. |
| `permission.ask`                         | `(perm, output) => "ask"\|"deny"\|"allow"` | Override the permission decision (cross-ref agent 08). |
| `tool.execute.before` / `tool.execute.after` | `(meta, output)` mutator                | Mutate args / mutate result. Called for both built-ins **and** MCP tools (`session/prompt.ts:428,469,487`). |
| `tool.definition`                        | `(input, output)`                          | Mutate description/parameters per call (`registry.ts:306`). |
| `command.execute.before`                 | inject parts before slash-command runs      | |
| `shell.env`                              | mutate env passed to shell tool             | |
| `experimental.chat.{messages,system}.transform`, `experimental.session.compacting`, `experimental.compaction.autocontinue`, `experimental.text.complete` | Various post-processing hooks. |
| `experimental_workspace.register(type, adapter)` | Workspace adapter | Plugins can introduce new workspace backends (`plugin/index.ts:137-141`). |

Lifecycle: plugins load **sequentially** to keep registration order
deterministic (`plugin/index.ts:207-230`). Bus subscription is
fork-scoped to the plugin's lifetime. Plugin failures publish a
`session.error` rather than crashing the server.

## 5. `.opencode/command/` — slash commands

Markdown with frontmatter, glob-loaded by `config/command.ts:27-62`.
Frontmatter keys: `description`, `agent`, `model`, `subtask`. Body is a
prompt template; `$ARGUMENTS` and `$1..$N` are substituted at run time.
Loaded as `cfg.command` and merged with built-in `init`/`review`,
plus MCP prompts and Skills, into the unified slash-command table
(`command/index.ts:71-163`). Commands fire `command.executed` on the
bus.

## 6. Tool-use on the wire

The model's tool call goes through the AI SDK stream protocol; the
processor (`session/processor.ts:276-423`) translates each frame:

```text
tool-input-start  → ToolPart{state:"pending", input:{}, raw:""}
                    EventV2 SessionEvent.Tool.Input.Started
tool-input-delta  → ignored (delta accumulated by AI SDK internally)
tool-input-end    → EventV2 SessionEvent.Tool.Input.Ended
tool-call         → ToolPart{state:"running", input, time.start}
                    EventV2 SessionEvent.Tool.Called
tool-result       → ToolPart{state:"completed", output, title, metadata, attachments?, time.end}
                    EventV2 SessionEvent.Tool.Success
tool-error        → ToolPart{state:"error", error, time.end}
                    EventV2 SessionEvent.Tool.Failed
```

Each transition is broadcast as `message.part.updated` over the SSE
bus (`session/message-v2.ts:629-634`). `callID` is the AI-SDK
`toolCallId` and is the only pairing key; consumers correlate
`tool_use → tool_result` by `(sessionID, callID)`.

Example completed `ToolPart` on disk (sketched from
`session/message-v2.ts:309-324`):

```jsonc
{
  "type": "tool",
  "id": "prt_…", "messageID": "msg_…", "sessionID": "ses_…",
  "tool": "read",
  "callID": "call_…",
  "state": {
    "status": "completed",
    "input":  { "filePath": "/abs/path", "limit": 200 },
    "output": "<truncated text>",
    "title":  "src/foo.ts",
    "metadata": { "preview": "…", "truncated": false },
    "time": { "start": 1736870000000, "end": 1736870000123 }
  }
}
```

**Streaming progress within a tool call**: only `shell` does this. It
calls `ctx.metadata({ metadata: { output: <preview>, description } })`
on every stdout chunk (`shell.ts:497-502`), which writes through to the
`ToolPart.state.metadata` while still in `running`, and each write fires
another `message.part.updated`. There is **no** dedicated
`renderToolUseProgressMessage`-style tool-specific progress channel like
Claude's; the convention is "tool keeps mutating its `metadata` while
running". `task` (sub-agent) progress is exposed via the child
session's own `message.part.updated` events on `session.id ===
ctx.callID`-derived sub-session.

## 7. Implications for `opencode-headless`

- Tool catalog is small enough to enumerate statically; do that once at
  startup via `GET /tool` (or by mirroring `registry.ts`'s ID list) and
  treat anything else as MCP-backed by name shape (`<server>_<name>`).
- The `SemanticChannel` `tool_use` / `tool_result` mapping is direct:
  one `message.part.updated` of a `ToolPart` covers both — pair by
  `(sessionID, callID)`, dispatch by `state.status`.
- `tool.execute.before/after` are the right hooks for an
  approval-injection or audit-trail layer; they fire for built-ins **and**
  MCP, which is exactly what the existing two packages have to fake by
  intercepting the proxy.
- MCP `needs_auth` status must be surfaced — there is no equivalent in
  Claude/Codex, so the channel taxonomy needs a new `auth_required` event
  (or this rides `ScreenChannel.activity`).

## 8. Gaps / unknowns

- The exact SSE event name(s) the public server emits for
  `message.part.updated` and `message.part.delta` were not located in
  `sdks/`; the bus event names are confirmed but the wire-level mapping
  on the HTTP side (agent 02's territory) was not.
- Whether `tool-input-delta` carries partial-JSON the consumer can
  render is unconfirmed — `processor.ts:305-307` ignores it; it may
  still be re-emitted on the bus by the AI SDK layer.
- MCP `resources` are listable via `MCP.resources()` but I did not find
  any consumer surface that auto-attaches them to user messages.
