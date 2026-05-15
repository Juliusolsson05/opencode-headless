# Provider abstraction in OpenCode

## TL;DR — OpenCode does not have its own per-provider parser

OpenCode does **not** roll its own Anthropic-SSE / OpenAI-Responses /
Bedrock / Gemini parser the way `claude-code-headless` and
`codex-headless` do. It delegates *all* provider-specific wire decoding
to the **Vercel AI SDK** (`ai` package), and consumes its
`streamText({ ... }).fullStream` as the unified event vocabulary.

Concretely: `packages/opencode/src/session/llm.ts:55` types the
internal event as

```ts
type Result = Awaited<ReturnType<typeof streamText>>
export type Event = Result["fullStream"] extends AsyncIterable<infer T> ? T : never
```

That `Event` is OpenCode's "unified AssistantEvent". The 17-case switch
in `packages/opencode/src/session/processor.ts:220` is the only place
the model-side stream is interpreted, and every case is an AI-SDK
event tag (`text-delta`, `reasoning-delta`, `tool-input-start`,
`tool-call`, `tool-result`, `tool-error`, `start-step`,
`finish-step`, `finish`, `error`, …) — never a wire-protocol literal
like `content_block_delta` or `response.output_item.done`. The same
file is the *only* consumer; nothing else in OpenCode peeks at raw
provider frames.

This is the single most consequential finding for `opencode-headless`:
**we never need to parse Anthropic SSE or OpenAI Responses ourselves.**
Whatever stream the OpenCode HTTP server publishes downstream is
already provider-agnostic. Agent 02 will name those wire events; agent
07 will confirm screen has no live signal we'd need to backfill.

## Where each provider lives (registry)

The provider registry is a static map in
`packages/opencode/src/provider/provider.ts:96-117` (`BUNDLED_PROVIDERS`).
Each entry is `npm-package-name → () => Promise<factory>`. The model
catalogue itself is fetched from `https://models.dev` at runtime and
cached in `~/.local/share/opencode/...models.json`
(`packages/opencode/src/provider/models.ts:105`).

| OpenCode provider id (typical) | npm package | Wire dialect actually parsed |
|---|---|---|
| `anthropic` | `@ai-sdk/anthropic` | Anthropic Messages SSE |
| `openai` | `@ai-sdk/openai` | OpenAI Responses (forced via `sdk.responses(modelID)` at `provider.ts:187`) |
| `azure` | `@ai-sdk/azure` | Responses or Chat Completions, picked at `provider.ts:141` |
| `amazon-bedrock` | `@ai-sdk/amazon-bedrock` | Bedrock Converse stream |
| `google` | `@ai-sdk/google` | Gemini streaming |
| `google-vertex` / `google-vertex-anthropic` | `@ai-sdk/google-vertex(/anthropic)` | Vertex / Anthropic-on-Vertex |
| `openrouter` | `@openrouter/ai-sdk-provider` | OpenRouter pass-through |
| `xai` | `@ai-sdk/xai` | xAI Responses |
| `mistral` | `@ai-sdk/mistral` | Mistral chat |
| `groq` | `@ai-sdk/groq` | Groq chat |
| `deepinfra`, `cerebras`, `cohere`, `togetherai`, `perplexity`, `vercel`, `alibaba` | corresponding `@ai-sdk/*` | Chat-completion variants |
| `gateway` | `@ai-sdk/gateway` | Vercel AI Gateway |
| `gitlab` | `gitlab-ai-provider` | GitLab Duo workflow (custom WS, special-cased in `llm.ts:232`) |
| `github-copilot` | local `./sdk/copilot/copilot-provider` | OpenAI-compatible; auto-flips to Responses for GPT-5+ at `provider.ts:204` |
| `venice` | `venice-ai-sdk-provider` | OpenAI-compatible |
| `opencode` (hosted) | `@ai-sdk/anthropic` (with `apiKey: "public"` fallback) | Anthropic via opencode.ai gateway |

OpenCode-specific overlays (auth, headers, model-id selection, region
prefixing for Bedcdk) live in the `custom()` table at
`provider.ts:149-410`. None of that overlay touches the wire stream
— it only tweaks request shape and SDK construction. Wire-side parsing
remains 100% the AI SDK's job.

## The unified internal event shape

The `fullStream` tags handled by `processor.ts` (the canonical list):

| AI SDK event | What it carries | OpenCode persists as |
|---|---|---|
| `start` | session begins | `status: busy` (no part) |
| `start-step` / `finish-step` | per-LLM-call boundaries; usage, finish reason, snapshot | `step-start` / `step-finish` parts |
| `text-start` / `text-delta` / `text-end` | assistant prose | one `TextPart` per id; `updatePartDelta` for each chunk |
| `reasoning-start` / `reasoning-delta` / `reasoning-end` | extended thinking / OpenAI reasoning summaries | `ReasoningPart` (one per `id`); SDK-merged across providers |
| `tool-input-start` / `-delta` / `-end` | streamed tool args | `ToolPart` with `state: { status: "pending", raw: "" }` |
| `tool-call` | finalized tool args (server-validated) | `state.status: "running"`, `state.input: {...}` |
| `tool-result` | tool output, possibly with attachments | `state.status: "completed"` + `Tool.Success` v2 event |
| `tool-error` | tool failure | `state.status: "error"` + `Tool.Failed` |
| `error` | stream-level error | thrown; turns into `Step.Failed` |
| `finish` | stream complete | finalize message (no-op in handler) |

Each persisted `Part` is then re-broadcast over the Bus as
`message.part.updated` (whole part) or `message.part.delta` (text
patch only) — see `session.ts:768`, `message-v2.ts:629-651`. There is
also a parallel **v2 SessionEvent** stream
(`packages/opencode/src/v2/session-event.ts`) currently dual-written
alongside the part stream. v2 names look like
`session.next.text.delta`, `session.next.tool.input.started`,
`session.next.step.ended` — same vocabulary, different aggregate
boundary. Either is sufficient for `opencode-headless`; pick whichever
agent 02 finds on the wire.

## Mapping to the existing SemanticChannel vocabularies

| AI-SDK / OpenCode unified | claude-code-headless `SemanticChannel` | codex-headless `SemanticChannel` |
|---|---|---|
| `start-step` | `turn_started` | `turn_started` |
| `text-delta` | `text_delta` + `turn_delta` | `text_delta` + `turn_delta` |
| `reasoning-delta` | `thinking_delta` | `thinking_delta` |
| `tool-input-start` | `block_started` (kind=`tool_use`) | `tool_started` |
| `tool-input-delta` | `tool_input_delta` | (n/a — Codex finalises args server-side) |
| `tool-input-end` / `tool-call` | `tool_input_finalized` | (covered by `tool_started`) |
| `tool-result` | `tool_result` | `tool_completed` |
| `tool-error` | `tool_result` (with `is_error`) | `tool_completed` (with `success: false`) |
| `finish-step` | `turn_completed` + `usage_updated` | `turn_completed` + `usage_updated` |
| `finish` | (none — covered by stop) | (none) |
| `error` | `stream_error` / `api_error` | `stream_error` / `api_error` |
| no analogue | `signature` (Anthropic thinking sig) | no analogue |
| no analogue | `citations_delta` / `connector_text_delta` | no analogue |

So the OpenCode/AI-SDK vocabulary is a clean **subset-superset** of
ours: it normalises away Anthropic's `signature_delta`, partial-JSON
streaming framing, citation deltas, and connector-text deltas (the SDK
either folds them into `providerMetadata` on the surrounding
text/reasoning event or discards them); it adds explicit
`tool-input-{start,delta,end}` framing that both Claude and Codex have
to derive. Translating one→the other is mechanical except for the
losses below.

## Provider-specific concepts that don't normalize cleanly

1. **Anthropic `signature_delta` / extended-thinking signatures.** The
   AI SDK exposes the signed blob only on `providerMetadata` of the
   surrounding `reasoning-end`, not as its own event. If we want
   parity with `claude-code-headless`'s `SemanticSignatureEvent`, we
   read it out of `reasoning.metadata.anthropic.signature` (or
   whatever the AI SDK key is — needs runtime confirmation).
2. **Anthropic citations / `citations_delta`.** Same story — folded
   into `providerMetadata` rather than streamed. Loss of streaming
   granularity is unavoidable through this path.
3. **Anthropic server-tool-use** (web_search, bash_20250124, etc.).
   `processor.ts:295` flags these via
   `metadata.providerExecuted = true`. `tool-result` arrives with
   `provider.executed: true`. We can preserve this on our side as a
   tag on the tool block.
4. **OpenAI Responses' interleaved `reasoning_summary`.** Surfaces as
   normal `reasoning-*` events; the AI SDK merges across reasoning
   `id`s. Our `thinking_delta` consumes it identically.
5. **`provider.executed` + MCP routing.** OpenCode marks server-side
   MCP / `@ai-sdk/*` "remote-executed" tools by setting
   `metadata.providerExecuted` at part creation, so the resulting
   `tool` part is *not* hit by our local executor. That metadata
   propagates onto every Bus event.
6. **`fine-grained-tool-streaming` / `interleaved-thinking` headers**
   (`provider.ts:156`) are forced on for Anthropic. They affect how
   often `tool-input-delta` and interleaved `reasoning-delta` fire,
   not the event shape. Behavioural, not structural.
7. **GitLab "Duo Workflow"** is the one provider that bypasses the AI
   SDK's HTTP transport — it talks WebSocket to a workflow service and
   hand-rolls tool execution at `llm.ts:232-313`. Still emits the
   same `fullStream` events upward. Edge case; ignore for v1.

## What this means for `opencode-headless`

- **No wire parser.** We do not build an analogue of
  `claude-code-headless/src/proxy/sseFraming.ts` or
  `codex-headless/src/proxy/openaiResponses.ts`. The OpenCode server
  has already done it, twice over (AI SDK + processor → Part stream).
- **Single provider-agnostic adapter.** `SemanticChannel` is fed by
  one consumer of `message.part.{updated,delta}` (or v2 `session.next.*`),
  with a small switch that maps the ~17 unified tags to our
  ~13-event channel surface. Per-provider branches inside that
  adapter should be rare, mostly for surfacing `providerMetadata`
  back out as `signature` / citation events when consumers want
  them.
- **We do need to track the model.** The wire events carry
  `providerMetadata` and `provider.executed`; consumers like the
  agent-code IDE want to show "this came from anthropic / claude-4-5"
  on the block. That info rides on `Step.Started` (model ref) and
  `Tool.Called` (`provider.metadata`). Carry it through verbatim.
- **Lossy concepts (signature, citations, connector text)** are
  best-effort: they survive on `providerMetadata` but lose streaming
  granularity. Document this as a known divergence from
  `claude-code-headless`.

## Open questions / unknowns

- Exact field name the AI SDK uses for Anthropic thinking signatures
  on `reasoning.providerMetadata`. Needs an instrumented run; not
  visible from static read.
- Whether the OpenCode HTTP server forwards `message.part.delta` (live
  text-chunk patches) or only `message.part.updated` (post-aggregate).
  Agent 02 owns this.
- Whether the v2 `SessionEvent` stream is on the wire yet, or still
  internal-only ("Temporary dual-write" comments at
  `processor.ts:228`, `:262`, `:280` …). If it's wire-exposed it is
  the cleaner subscription target than the legacy part-update stream.
