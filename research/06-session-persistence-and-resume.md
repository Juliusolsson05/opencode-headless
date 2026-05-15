# 06 — Session persistence & resume

## Verdict (lead)

OpenCode does not use JSONL. It uses **SQLite (Drizzle / `bun:sqlite`)** with
WAL mode for the durable transcript. The semantic-streaming question maps to
two different event channels with two different durabilities:

| Channel               | Kind         | DB write?            | Bus emit? | Catch-up via REST? |
| --------------------- | ------------ | -------------------- | --------- | ------------------ |
| `message.part.updated`| `SyncEvent`  | yes (immediate tx)   | yes       | yes                |
| `message.part.delta`  | `BusEvent`   | **no** — ephemeral   | yes       | **no**             |

So OpenCode is a **hybrid**: each `Part` is persisted at its boundaries
(`text-start` writes an empty part row, `text-end` writes the final assembled
text — see `packages/opencode/src/session/processor.ts:514-575`), and the
deltas in between fly only on the bus. That means:

- Within a turn, the DB lags by one delta-batch — closer to Claude's lazy
  JSONL than to Codex's truly-live rollout, but tighter than Claude
  because OpenCode also writes the *empty* placeholder part as soon as
  streaming starts (so a late attacher sees the part exists, just empty,
  and must replay live deltas to fill it).
- Across turns, OpenCode is fully durable — every assistant message,
  reasoning chunk, tool input/output, compaction marker, and user input
  is one row in `part` / `message` / `session_message` keyed by ULID-ish
  IDs.

Architecturally for `opencode-headless`: there is **no semantic file to
tail**. The semantic source is the SSE event bus (`GET /event`); the
durable source is SQLite via REST (`GET /session/:id/message`). The
proxy / JSONL-tail / live-owner machinery from the other two packages
collapses into SSE + a SQLite snapshot on (re)attach.

## On-disk layout

| Item                  | Path                                                   |
| --------------------- | ------------------------------------------------------ |
| Database file         | `${XDG_DATA_HOME}/opencode/opencode.db` (channel-suffixed for `dev`/`canary` etc.) |
| Override env          | `OPENCODE_DB=:memory:` or absolute path                |
| Legacy JSON storage   | `${XDG_DATA_HOME}/opencode/storage/{project,session,message,part,todo,permission,session_share}/...` (migrated into sqlite on startup) |
| Plans                 | `<worktree>/.opencode/plans/` (project-scoped) or `${data}/plans` (global) |

Source: `packages/opencode/src/storage/db.ts:30-43`,
`packages/core/src/global.ts:9-29`, `packages/opencode/src/session/session.ts:347-352`.

`Global.Path.data` resolves through `xdg-basedir` →
`~/.local/share/opencode` (Linux) / `~/Library/Application Support/opencode`
(macOS) / `%APPDATA%\opencode` (Windows).

The database opens with `journal_mode=WAL`, `synchronous=NORMAL`,
`busy_timeout=5000`, `foreign_keys=ON`
(`packages/opencode/src/storage/db.ts:96-101`). WAL is what makes
read-while-write reattach safe from a sibling process.

The legacy JSON tree (`storage/`) is only consulted by a one-shot
JSON→SQLite migration (`storage/json-migration.ts:25-429`). The residual
`Storage` JSON service (`storage/storage.ts`) is now used only for
`session_diff/<sessionID>.json` snapshots (`session.ts:724-728`).
Messages and parts go through Drizzle.

## Schema (durable)

Five tables matter for transcript reattach (full DDL in
`packages/opencode/src/session/session.sql.ts`):

| Table        | PK            | Notable cols                                                                                       |
| ------------ | ------------- | -------------------------------------------------------------------------------------------------- |
| `session`    | `id` (ULID)   | `project_id`, `workspace_id?`, `parent_id?`, `directory`, `path`, `title`, `version`, `agent`, `model{json}`, `permission{json}`, `summary_*`, `revert{json}`, `time_{created,updated,compacting,archived}` |
| `message`    | `id` (ULID)   | `session_id`, `time_created`, `data{json}` (entire `User` or `Assistant` envelope minus id/sessionID) |
| `part`       | `id` (ULID)   | `message_id`, `session_id`, `time_created`, `data{json}` (the discriminated `Part` minus ids)      |
| `event_sequence` | `aggregate_id` (= `sessionID`) | `seq`, `owner_id?`                                                          |
| `event`      | `id`          | `aggregate_id`, `seq`, `type` (`<name>.<version>`, e.g. `session.updated.1`), `data{json}`         |

Project ID is **not** the cwd hash — it's the **first-parent commit
SHA** of the worktree (`git rev-list --max-parents=0 HEAD`). Cite:
`packages/opencode/src/storage/storage.ts:116-119` (migration), and
`packages/opencode/src/project/project.ts:248`. This is a stronger
anchor than Claude's sanitized-cwd model — moving a checkout doesn't
fork the session list.

### Part variants (`Part` discriminator at message-v2.ts:405-447)

| `type`        | Purpose                               | Streaming pattern                                                              |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| `text`        | Assistant text                        | placeholder on `text-start`, deltas on bus only, final on `text-end`           |
| `reasoning`   | Thinking blocks                       | placeholder on `reasoning-start`, deltas on bus only, final on `reasoning-end` |
| `tool`        | Tool call (state: pending → running → completed/error) | full row written on `tool-input-start`, mutated on `tool-call`/`tool-result`   |
| `file`        | File attachment (user input)          | written once                                                                   |
| `agent`       | `@agent` mention                      | written once                                                                   |
| `step-start` / `step-finish` | Per-step boundaries (cost, tokens) | written at boundary                                                       |
| `snapshot` / `patch`         | VCS snapshot ids and diffs        | written by snapshot module after turn                                          |
| `subtask`     | Spawned sub-agent prompt              | written once                                                                   |
| `retry`       | Retry attempt + error                 | written once                                                                   |
| `compaction`  | Compact-boundary marker (see below)   | written at compaction time                                                     |

## Sample envelopes

`SyncEvent` row in the `event` table (the wire / replay format):

```json
{
  "id":           "evt_01J9...",
  "aggregate_id": "ses_01J9...",
  "seq":          47,
  "type":         "message.part.updated.1",
  "data": {
    "sessionID": "ses_01J9...",
    "time": 1715712345678,
    "part": {
      "id":        "prt_01J9...",
      "messageID": "msg_01J9...",
      "sessionID": "ses_01J9...",
      "type":      "text",
      "text":      "Sure, here's the diff...",
      "time":      { "start": 1715712340000, "end": 1715712345678 }
    }
  }
}
```

`message.part.delta` on the SSE bus (NOT persisted):

```json
{
  "id":   "evt_...",
  "type": "message.part.delta",
  "properties": {
    "sessionID": "ses_...",
    "messageID": "msg_...",
    "partID":    "prt_...",
    "field":     "text",
    "delta":     "Sure, "
  }
}
```

## Live-vs-lazy — proof

Hot path for a streaming text token, in
`packages/opencode/src/session/processor.ts`:

| LLM event       | Code                                       | Effect                                       |
| --------------- | ------------------------------------------ | -------------------------------------------- |
| `text-start`    | `session.updatePart(ctx.currentText)` (L531) | `SyncEvent` → DB insert of empty part        |
| `text-delta`    | `session.updatePartDelta({...})`     (L538-544) | `Bus.publish(PartDelta)` only — **no DB**   |
| `text-end`      | `session.updatePart(ctx.currentText)` (L573) | `SyncEvent` → DB upsert with full text       |

`updatePartDelta` (session.ts:761-769) just calls
`bus.publish(MessageV2.Event.PartDelta, ...)`. PartDelta is a plain
`BusEvent.define(...)` (message-v2.ts:635-644), not a `SyncEvent` — no
projector, no `event` row, no `part` row.

The PartUpdated projector (`projectors.ts:121-139`) calls
`db.insert(PartTable).onConflictDoUpdate(...)` inside an immediate
transaction (`sync/index.ts:154-170`), so every `updatePart` hits
SQLite synchronously before returning.

## Reattach contract

Three orthogonal modes:

1. **Cold snapshot** — `GET /session/:sessionID/message` returns the
   full `WithParts[]` array reconstructed from `MessageTable` +
   `PartTable` (server route at
   `server/routes/instance/session.ts:594` / httpapi v2 at
   `httpapi/groups/v2/message.ts:9-56`). This is the equivalent of
   reading the whole JSONL file once.

2. **Live tail** — `GET /event` is a Hono SSE endpoint
   (`server/routes/instance/event.ts:12-90`) that subscribes to
   `Bus.subscribeAll` and streams every bus event (sync + non-sync)
   forward from the moment of connection, with a 10s heartbeat. **No
   replay-from-offset on this endpoint** — it's strictly live.

3. **Replay-from-seq** — `POST /sync/history` takes a `Record<aggregateID,
   lastSeq>` and returns every persisted event with `seq > lastSeq` for
   each known aggregate, plus full history for unknown aggregates
   (`server/routes/instance/sync.ts:158-198`). This is the canonical way
   to "catch up" a client that was disconnected. Only `SyncEvent`s are
   in `EventTable`, so this gives you `session.created`,
   `session.updated`, `message.updated`, `message.part.updated`,
   `message.part.removed`, `message.removed`, `session.deleted` — every
   durable mutation in seq order.

Reattach recipe a `opencode-headless` client should use:

```
1. open SSE /event           ← start buffering live events (have a queue)
2. GET  /session/:id/message ← snapshot of all messages+parts
3. POST /sync/history        ← {sessionID: snapshotMaxSeq} to backfill
                               anything that landed between (1) and (2)
4. drain SSE buffer + apply  ← honour ordering by `seq` for sync events
                               and by arrival for non-sync (PartDelta)
```

This is structurally similar to claude-headless's "snapshot via JSONL +
live via proxy SSE" but cleaner because OpenCode owns both endpoints —
no MITM, no PTY mirror, no live-owner state machine to arbitrate
proxy-vs-jsonl ownership.

### Mid-stream reattach behaviour

If you connect after `text-start` but before `text-end`, then:

- `GET /session/:id/message` returns the part row with whatever text was
  last upserted — which is the empty placeholder from `text-start`.
- `POST /sync/history` doesn't fill the gap because the in-flight deltas
  were never persisted as `SyncEvent`s.
- You **cannot fully reconstruct** the partial text. You see "part
  exists, type=text, text=''", and you have to wait for the `text-end`
  upsert (or the next placeholder-write that some part types do
  mid-stream — `tool` parts get re-written on every state transition,
  so they're better) before you have ground truth.

This is the single most important behavioural difference vs Codex's
rollout: in Codex, every delta is on disk the moment it arrives, so a
late-attacher sees byte-exact partial state. In OpenCode you get
"placeholder + live deltas going forward" — same semantics as Claude's
write-on-complete JSONL, but with an explicit empty-placeholder row so
the part identity exists even mid-stream.

If the existing channel/owner model wants byte-exact partials on
reattach, `opencode-headless` would have to **buffer PartDelta on the
client** (in-memory, keyed by `partID`) for any in-flight part, because
the server discards them. Once `PartUpdated` lands with the final text,
the client's local accumulator can be cross-checked / discarded.

## Compaction (the `compact_boundary` analog)

OpenCode has a first-class `CompactionPart`
(message-v2.ts:213-222):

```ts
{ type: "compaction", auto: boolean,
  overflow?: boolean, tail_start_id?: MessageID }
```

When `compaction.ts` runs (manually or auto-on-overflow), it produces a
new assistant message whose body is the summary, plus a compaction part
attached to the *parent* user message that points to where the kept
"tail" begins (`compaction.ts:595-599`, `messages-v2.ts:1107-1130`).
Replay logic in `MessageV2.stream(...)` reorders the kept tail back into
position. Persistence is via `updatePart` like everything else — so
compaction boundaries are durable and replayable. There's also a
`session.compacting` timestamp on the session row (`session.sql.ts:45`)
and a `session.compacted` bus event (`compaction.ts:27-34`).

For `opencode-headless` this means compaction maps cleanly onto the
existing `compact_boundary` envelope concept — surface it as one
synthetic transcript event derived from the `compaction` Part rows.

## Open questions / gaps

- Whether `event_sequence.owner_id` is set in non-experimental mode.
  The `EventTable` rows are gated on
  `Flag.OPENCODE_EXPERIMENTAL_WORKSPACES` (`sync/index.ts:287-307`) —
  worth confirming whether the default install actually persists
  history rows or only emits to the bus. If not, replay-from-seq is
  experimental-only and the cold-snapshot path is the *only* reattach
  story.
- The `share/` and slack/webapp paths feed an external CRDT-style
  syncing layer not investigated here.
- Whether long-running tool runs cross-process (e.g. reload server) —
  `tool` part state machine is robust, but the running PTY/subprocess
  itself is not part of the persistence model.
