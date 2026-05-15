# Research 08 — Approval & permissions flow

## Punchline

**OpenCode has a first-class, structured approval surface that is delivered
over the same HTTP+SSE wire as everything else — there is nothing to PTY-parse
and no keystroke fallback to invent.** A `permission.asked` event is published
on the bus (and re-emitted to all SSE subscribers as
`/event` / `/global/event` payloads). The consumer answers with a single
JSON `POST /permission/{requestID}/reply`. The TUI (`PermissionPrompt` in
`packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`) is itself
*just another SSE consumer that calls the same SDK method*
(`sdk.client.permission.reply`, see lines 190, 201, 440, 447 of that file) —
so for `opencode-headless` the wire contract and the TUI contract are
identical, and "drive headless" means "subscribe to `/event`, watch for
`type === "permission.asked"`, POST a reply".

This is structurally **closer to Codex's `exec_approval_request` rollout
event than to Claude's screen-scraped permission overlay**, but better: the
reply path is a typed REST endpoint, not a keystroke into a PTY.

## Where it lives in source

| Concern | Path |
|---|---|
| Service + bus events + state machine | `packages/opencode/src/permission/index.ts` |
| Rule evaluation (last-match-wins wildcard) | `packages/opencode/src/permission/evaluate.ts` |
| Bash command-prefix arity (used for "always" patterns) | `packages/opencode/src/permission/arity.ts` |
| `PermissionID` newtype (KSUID-like) | `packages/opencode/src/permission/schema.ts` |
| Config schema (`Action = "ask" | "allow" | "deny"`, per-tool keys) | `packages/opencode/src/config/permission.ts` |
| Per-agent permission defaults (build / plan / explore / general) | `packages/opencode/src/agent/agent.ts:90-235` |
| HTTP routes (Hono) | `packages/opencode/src/server/routes/instance/permission.ts` |
| HTTP routes (effect HttpApi mirror) | `packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/permission.ts` |
| SQLite persistence of "always" approvals | `PermissionTable` in `packages/opencode/src/session/session.sql.ts:125` |
| Generated SDK client | `packages/sdk/js/src/v2/gen/sdk.gen.ts:2520-2630` (`Permission` class: `list`, `reply`, deprecated `respond`) |
| Generated SDK event type | `packages/sdk/js/src/v2/gen/types.gen.ts:106-119` (`PermissionRequest`), `:2308-2322` (`EventPermissionAsked`, `EventPermissionReplied`) |
| TUI prompt (sample consumer) | `packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx` |
| ACP bridge (translates to ACP `requestPermission`) | `packages/opencode/src/acp/agent.ts:191-229` |
| `opencode run` headless reply | `packages/opencode/src/cli/cmd/run.ts:544-564` |
| Web app's per-session "always allow this directory" persistence | `packages/app/src/context/permission.tsx` + `permission-auto-respond.ts` |

## The model

OpenCode normalizes everything into a `Ruleset` — an ordered array of
`{ permission, pattern, action }` rules where `action ∈ {allow, deny, ask}`.
`evaluate()` does a `findLast` over the merged ruleset using a wildcard
matcher on both `permission` and `pattern` (`evaluate.ts:11-14`); if nothing
matches the default is `ask`. The merge order is **defaults → user config →
session-approved**, so user config overrides defaults and session-approved
overrides both.

The `permission` axis is a *tool-name-ish* string. The known set
(`config/permission.ts:25-41`) is:

```
read, edit, glob, grep, list, bash, task, external_directory,
todowrite, question, webfetch, websearch, lsp, doom_loop, skill
```

…and the schema is open (`Schema.Record(Schema.String, Rule)`) so MCP /
plugin tools can register their own. The `pattern` axis depends on the
permission: a glob/path for `read|edit|external_directory|glob|grep|list|
skill`, a normalized command prefix for `bash` (see arity table — `git`
collapses to 2 tokens, `npm run` to 3, etc., so "always allow git" becomes
`always: ["git"]`), and a name for `task`.

This means OpenCode has **per-tool-and-per-target** granularity — exactly
what Codex hand-rolls in `conditions/approval.ts`, but native to the data
model. `bash` "always" = the prefix-collapsed command, not the full string.

## Lifecycle of one approval

1. Tool code calls `ctx.ask({ permission, patterns, always, metadata })`.
   See e.g. `tool/edit.ts:98`, `tool/shell.ts:282`, `tool/read.ts:179`,
   `tool/external-directory.ts:36`, `tool/webfetch.ts:37`, `tool/task.ts:45`.
2. `Permission.ask` (`permission/index.ts:179`) evaluates each pattern
   against the merged ruleset. Three terminal cases:
   - any pattern hits `deny` → fails the tool with `PermissionDeniedError`
     (no event, no prompt — the model gets the rule back as text).
   - all patterns hit `allow` → returns immediately, silent.
   - any pattern hits `ask` → mints a `PermissionID`, puts a `Deferred` in
     `pending`, publishes `Event.Asked` (`permission.asked`) on the bus,
     and *awaits the deferred*.
3. The bus event is fanned out to every SSE subscriber (TUI, web app, ACP
   agent, headless wrapper) via the standard `/event` stream.
4. Some consumer eventually calls `POST /permission/{id}/reply` with
   `{ reply: "once" | "always" | "reject", message?: string }`.
5. `Permission.reply` (`permission/index.ts:216`) resolves the deferred,
   publishes `Event.Replied` (`permission.replied`), and — if the reply was
   `"always"` — pushes the request's `always` patterns into the in-memory
   `approved: Ruleset`. **NOTE:** the in-memory `approved` is loaded from
   `PermissionTable` at startup (line 159) but I did not find a write-back
   call to persist newly-approved patterns. That looks like a TODO in the
   source; treat "always" as **session-scoped in practice**, even though
   the table's lifetime is project-scoped.
6. After `"always"`, the reply loop walks every other pending request for
   the same session and auto-resolves any whose patterns are now fully
   covered by the updated `approved` set (lines 258-271). One "always
   allow" can cascade-clear queued asks.

## Wire contract

### Request — `permission.asked` event

```jsonc
{
  "id": "evt_…",
  "type": "permission.asked",
  "properties": {                       // == PermissionRequest
    "id": "permission_01J…",            // PermissionID, the reply key
    "sessionID": "ses_…",
    "permission": "edit",               // axis string; "bash" uses ShellID.ToolID
    "patterns": ["src/foo.ts"],         // what THIS call needs approved
    "always": ["*"],                    // what "always" would approve
    "metadata": {                       // free-form, permission-specific
      "filepath": "/abs/src/foo.ts",
      "diff": "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n"
    },
    "tool": { "messageID": "msg_…", "callID": "call_…" }   // optional
  }
}
```

The TUI's per-permission rendering rules (the "what command/diff to show"
table) live in `permission.tsx:215-403`. Replicate this in the wrapper:

| permission | metadata key the TUI reads | preview shown |
|---|---|---|
| `edit` | `metadata.filepath`, `metadata.diff` | unified/split diff via `<diff>` |
| `read` | tool input `.filePath` | `Path: …` line |
| `glob` / `grep` | tool input `.pattern` | `Pattern: …` |
| `list` | tool input `.path` | `Path: …` |
| `bash` (`ShellID.ToolID`) | tool input `.description`, `.command` | `$ <command>` |
| `task` | tool input `.subagent_type`, `.description` | titlecased agent + `◉ desc` |
| `webfetch` | tool input `.url` | URL |
| `websearch` | tool input `.query` | query |
| `external_directory` | `metadata.parentDir`, `metadata.filepath`, `patterns` | dir + glob list |
| `doom_loop` | none | static "continue after failures" |
| MCP / unknown | — | generic `Call tool <name>` |

Note that for `read|glob|grep|list|bash|webfetch|websearch|task` the **tool
input is NOT inside `metadata`** — the TUI fetches it from the parts cache
(`permission.tsx:144-154`). A wrapper has two options: (a) cache parts the
same way and look up by `tool.messageID + tool.callID`, or (b) just expose
the raw `permission.asked` payload to its own consumer and let them
correlate. Option (b) matches the channel-model split.

### Response

| Method | Path | Body |
|---|---|---|
| `GET` | `/permission` | none — returns `PermissionRequest[]` (all pending across sessions) |
| `POST` | `/permission/{requestID}/reply` | `{ reply: "once" \| "always" \| "reject", message?: string }` |
| `POST` | `/session/{sessionID}/permissions/{permissionID}` | `{ response: "once" \| "always" \| "reject" }` — **deprecated**, kept for the web app |

`reject` with a `message` raises `PermissionCorrectedError` instead of
`PermissionRejectedError`, surfacing the user's correction back to the
model as tool feedback (`permission/index.ts:95-100`). One reject cascades:
the same session's other pending asks are also rejected (lines 234-244).

### Reply event

```jsonc
{ "id": "evt_…", "type": "permission.replied",
  "properties": { "sessionID": "…", "requestID": "permission_…",
                  "reply": "once" | "always" | "reject" } }
```

## Approval policy / sandbox model — what does and doesn't exist

| Codex/Claude concept | OpenCode equivalent |
|---|---|
| `approval_policy` (`never` / `on-request` / `untrusted`) | **No single dial.** Closest is the `permission` config (`Action` shorthand `"allow" \| "deny" \| "ask"` applied to all tools) plus per-agent overrides. `opencode run --dangerously-skip-permissions` answers `once` to every ask in non-interactive mode (`run.ts:548`). |
| `sandbox_policy` (read-only / workspace-write / danger-full) | **No OS sandbox.** No seccomp, no chroot, no network jail. The cwd jail is enforced via the `external_directory` permission — every file/dir tool calls `assertExternalDirectoryEffect` and asks if the target is outside `instance.directory`. Network access is gated *per-tool* (`webfetch`, `websearch` actions). The word "sandbox" in the source means a git worktree (`project.sandboxes`), not a security boundary. |
| `Yes / Yes-don't-ask-again / No-and-tell` keystrokes | `reply ∈ {"once","always","reject"}` + optional `message` ⇒ identical semantics. |
| Per-call command preview | `metadata` carries it (`diff` for edits, `command` via tool input for bash). |
| "Always allow" memory | In-memory per-instance `approved` ruleset; `PermissionTable` reads at boot but write-back is unimplemented (see Gaps). The web app layers its own client-side `autoAccept` map keyed by `(sessionID, base64(directory))` with parent-session lineage (`permission-auto-respond.ts`) and persists it in localStorage — this is **app-side**, not server-side. |
| Bypass mode | `--dangerously-skip-permissions` on `opencode run`. There is no equivalent flag on `opencode serve`; a wrapper that wants "auto-allow all" must subscribe and reply `"once"` itself. |

## Gaps / unknowns

- **`approved` persistence is unclear.** The startup read from
  `PermissionTable` exists (`permission/index.ts:159`) but I found no
  `Database.use((db) => db.insert/update(PermissionTable))` site for the
  push at line 251. Either the persistence layer wraps it elsewhere or
  "always" is effectively session-scoped today. Worth instrumenting before
  documenting `opencode-headless`'s "always = forever" semantics.
- **Concurrency model under multiple subscribers.** Nothing dedupes replies
  — first POST wins, second is a silent no-op (`pending.get` returns
  undefined). That is fine for `opencode-headless` but means a wrapper
  competing with the live TUI can race the user.
- **MCP tool approvals** ride on the same channel via `permission ===
  "workflow_tool_approval"` (`session/llm.ts:281-309`); haven't traced
  whether the patterns are stable across MCP server restarts.
