# OpenCode Source Audit Notes

This is a working audit file for the temporary headless harness. It is not
production documentation.

## Source checkout

OpenCode is vendored as a git submodule at:

```text
vendor/opencode-src
```

Current audited commit:

```text
321db7a81
```

## Event completeness

The `/event` endpoint is complete for live instance events.

Evidence:

- `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`
  builds the SSE response from `bus.subscribeAll()`, prepends
  `server.connected`, and merges a 10 second `server.heartbeat`.
- `packages/opencode/src/server/routes/instance/httpapi/api.ts` builds the
  OpenAPI `Event` schema from `BusEvent.effectPayloads()` plus sync event
  schemas.
- `packages/opencode/src/bus/bus-event.ts` includes both legacy bus definitions
  and `EventV2.registry`.
- `packages/opencode/src/event-v2-bridge.ts` bridges core `EventV2` events back
  into legacy bus payloads with `{ id, type, properties }`, which is exactly
  what the SSE endpoint emits.

Implication for `opencode-headless`: the top-level `raw` event is the
completeness guarantee. Mapped channels are convenience surfaces for Agent Code,
not the only source of truth.

## SDK v2 event union

Source of truth:

```text
vendor/opencode-src/packages/sdk/js/src/v2/gen/types.gen.ts
```

The generated `Event` union currently includes 73 live variants:

- server lifecycle: `server.connected`, `server.instance.disposed`,
  `server.heartbeat` on the wire, and `global.disposed`
- file: `file.edited`, `file.watcher.updated`
- LSP: `lsp.client.diagnostics`, `lsp.updated`
- message: `message.updated`, `message.removed`,
  `message.part.updated`, `message.part.delta`, `message.part.removed`
- permissions/questions: `permission.asked`, `permission.replied`,
  `question.asked`, `question.replied`, `question.rejected`
- session: `session.created`, `session.updated`, `session.deleted`,
  `session.status`, `session.idle`, `session.diff`, `session.error`,
  `session.compacted`
- session.next semantic stream: agent/model/prompt/synthetic, shell start/end,
  step start/end/fail, text/reasoning/tool input/tool call/tool progress/tool
  success/tool fail/retry/compaction events
- UI/control: TUI prompt/command/toast/session-select
- MCP: tools changed, browser open failed
- command/project/VCS/workspace/worktree/PTY/installation/catalog events

## Part shapes

OpenCode stores message content as `parts[]`, not as top-level `message.content`.
Relevant generated types:

- `TextPart`
- `ReasoningPart`
- `ToolPart`
- `StepStartPart`
- `StepFinishPart`
- `PatchPart`
- `AgentPart`
- `RetryPart`
- `CompactionPart`

Tool lifecycle lives under `ToolPart.state`:

- `pending`
- `running`
- `completed`
- `error`

The wrapper therefore extracts committed text from `parts[]`, not from a
Claude/Codex-style transcript field.

## Mapping policy

`opencode-headless` intentionally exposes two layers:

- `raw`: every upstream SSE event envelope, unchanged
- mapped channels: provider-agnostic Agent Code surfaces

Mapped channels should never hide data. If a category is not fully modeled, keep
the raw envelope in `metadata`.

Current mapping:

- `semantic`: text/reasoning/tool/message/session errors and lifecycle
- `screen`: activity, permissions, questions, compaction, file events, generic
  operational system events
- `committed`: durable message history fetched from `/session/{id}/message`

## Known follow-up reads

- `packages/opencode/src/cli/cmd/run/session-data.ts`
- `packages/opencode/src/cli/cmd/run/stream.transport.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/session.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
- `packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts`
- `packages/opencode/src/server/routes/instance/httpapi/groups/question.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts`
