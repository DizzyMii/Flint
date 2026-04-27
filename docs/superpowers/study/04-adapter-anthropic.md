# 04 — Adapter: Anthropic

**Source:** `packages/adapter-anthropic/src/index.ts`
**See also:** Doc 03 (adapter contract), Doc 01 (types)

---

## Internal Anthropic API types

All types below are private to the module — none are exported.

**`CacheControl`**
```ts
type CacheControl = { type: 'ephemeral' };
```
Singleton shape used wherever Anthropic accepts a cache hint. Only `'ephemeral'` is supported.

**`AnthropicTextBlock`**
```ts
type AnthropicTextBlock = {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
};
```
Used for both system blocks and assistant text content. The optional `cache_control` field is the injection point for prompt caching.

**`AnthropicImageBlock`**
Two discriminated variants keyed on `source.type`:
```ts
type AnthropicImageBlock =
  | { type: 'image'; source: { type: 'url'; url: string } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
```
The `url` variant requires only a URL string. The `base64` variant requires both a MIME `media_type` and the raw base64 `data`.

**`AnthropicToolUseBlock`**
```ts
type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
};
```
Appears in assistant messages when the model calls a tool. `input` is typed `unknown` because Anthropic echoes back whatever JSON it generated.

**`AnthropicToolResultBlock`**
```ts
type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
};
```
Appears in user messages as the reply to a prior `tool_use` block. `tool_use_id` must match the `id` from the originating `AnthropicToolUseBlock`.

**`AnthropicContentBlock`**
```ts
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;
```
The union of all four block types. Used as the element type of `AnthropicMessage.content` when content is an array rather than a plain string.

**`AnthropicMessage`**
```ts
type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};
```
Anthropic messages carry either a plain string (simple text) or a heterogeneous block array. The `system` role is not allowed here — system content travels in a top-level field on the request body.

**`AnthropicTool`**
```ts
type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
};
```
Anthropic uses `input_schema` (not `parameters`) for the JSON Schema definition. `cache_control` is injected on the last tool in the array when `cache === 'auto'`.

**`AnthropicRequestBody`**
```ts
type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  system?: AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stop_sequences?: string[];
  temperature?: number;
  stream?: boolean;
};
```
`max_tokens` is mandatory — Anthropic provides no unbounded mode. `system` is typed as `AnthropicTextBlock[]`, not a string, enabling per-block cache control. `stream` is set to `true` only by `stream()`, not by `call()`.

**`AnthropicUsage`**
```ts
type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};
```
Four fields. The two cache fields are optional because they are absent when prompt caching is not active. `cache_creation_input_tokens` counts tokens written into cache on this request; `cache_read_input_tokens` counts tokens served from cache. Only `cache_read_input_tokens` is mapped to Flint's `usage.cached`.

**`AnthropicResponse`**
```ts
type AnthropicResponse = {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  stop_sequence?: string | null;
  usage: AnthropicUsage;
};
```
Top-level shape of the non-streaming response body. `content` is always an array in the response (never a plain string), unlike request messages.

---

## mapStopReason

```ts
function mapStopReason(
  reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use',
): 'end' | 'tool_call' | 'max_tokens' | 'stop_sequence'
```

Maps Anthropic's four stop reasons to Flint's four:

| Anthropic        | Flint           |
|------------------|-----------------|
| `end_turn`       | `end`           |
| `stop_sequence`  | `stop_sequence` |
| `max_tokens`     | `max_tokens`    |
| `tool_use`       | `tool_call`     |

Implementation detail: `end_turn` and `stop_sequence` share a single `if` branch (`reason === 'end_turn' || reason === 'stop_sequence'`), with an inner ternary routing them to their distinct Flint values. `max_tokens` and `tool_use` each have their own branch. An unreachable fallback returns `'end'`.

---

## normalizeMessages

```ts
function normalizeMessages(
  messages: Message[],
  cache: 'auto' | 'off' | undefined,
): { system: AnthropicTextBlock[] | undefined; messages: AnthropicMessage[] }
```

Converts a Flint `Message[]` to the shape Anthropic expects. Iterates with an explicit `while (i < messages.length)` index so the tool-coalescing step can advance `i` across multiple messages in one pass.

**Step 1 — System extraction.**
Any message with `role === 'system'` is pushed to `systemBlocks: AnthropicTextBlock[]` and not added to the messages array. Anthropic requires system content in a top-level `system` field on the request body, separate from the conversation turn array.

**Step 2 — Tool message coalescing.**
When a message has `role === 'tool'`, an inner `while` loop collects all immediately following `tool` messages into a single `toolResults: AnthropicToolResultBlock[]` array, each with `tool_use_id` sourced from `m.toolCallId`. The entire batch is pushed as a single `{ role: 'user', content: toolResults }` turn. Anthropic requires all tool results for a given exchange to arrive together in one user message; splitting them across separate turns is a protocol error.

**Step 3 — User messages.**
- String `content` passes through as-is: `{ role: 'user', content: msg.content }`.
- `ContentPart[]` is mapped to `AnthropicContentBlock[]`:
  - `part.type === 'text'` → `AnthropicTextBlock`
  - `part.type === 'image'` → `AnthropicImageBlock` with `source.type: 'url'`
  - `part.type === 'image_b64'` → `AnthropicImageBlock` with `source.type: 'base64'`, carrying `mediaType` and `data`

**Step 4 — Assistant messages.**
Text content (if present) becomes an `AnthropicTextBlock` pushed first. Tool calls (if present) become `AnthropicToolUseBlock` entries pushed after. Three outcome cases:
1. `blocks.length === 0` — content was falsy with no tool calls; send `msg.content` directly (degenerate case).
2. `blocks.length === 1 && blocks[0].type === 'text' && !msg.toolCalls?.length` — exactly one text block and no tool calls; send `msg.content` as a plain string to avoid unnecessary array wrapping.
3. Otherwise — send `blocks` as a content array (mixed text + tool-use, or tool-use only).

**Step 5 — Cache injection.**
After the loop, if `cache === 'auto'` and `systemBlocks` is non-empty, the last element in `systemBlocks` receives `cache_control: { type: 'ephemeral' }`. This marks the end of the stable system context as a cache boundary.

**Return value:** `{ system: AnthropicTextBlock[] | undefined, messages: AnthropicMessage[] }`. `system` is `undefined` (not an empty array) when no system messages were present, letting `buildBody` omit the field from the request body entirely.

---

## buildBody

```ts
function buildBody(req: NormalizedRequest, streaming: boolean): AnthropicRequestBody
```

Assembles the full `AnthropicRequestBody` from a `NormalizedRequest`.

- Calls `normalizeMessages(req.messages, req.cache)` to get `{ system, messages }`.
- Sets `max_tokens: req.maxTokens ?? 4096`. The default of 4096 exists because Anthropic makes `max_tokens` a required field with no sentinel for "no limit". Callers that want a different ceiling must set `req.maxTokens` explicitly.
- Conditionally sets `body.system = system` only when `system` is truthy (avoids sending an empty or `undefined` field).
- Tool schema: maps each `NormalizedTool` to `AnthropicTool` using `t.jsonSchema ?? { type: 'object' }`. The fallback `{ type: 'object' }` is a permissive JSON Schema that accepts any object input when the caller did not supply an explicit schema.
- Cache injection on tools: if `cache === 'auto'` and the tools array is non-empty, the last `AnthropicTool` in the array gets `cache_control: { type: 'ephemeral' }`. This caches the tool definitions themselves, complementing the system-level cache boundary injected in `normalizeMessages`.
- Sets `stop_sequences`, `temperature` only when present on the request.
- Sets `stream: true` only when `streaming === true`. `call()` passes `false`; `stream()` passes `true`.

---

## buildHeaders

```ts
function buildHeaders(): Record<string, string>
```

Closure over `opts.apiKey`. Returns four headers:

| Header               | Value                       | Purpose                                      |
|----------------------|-----------------------------|----------------------------------------------|
| `x-api-key`          | `opts.apiKey`               | Authentication                               |
| `anthropic-version`  | `2023-06-01`                | API version pin                              |
| `anthropic-beta`     | `prompt-caching-2024-07-31` | Activates the prompt caching beta feature    |
| `content-type`       | `application/json`          | Body encoding                                |

`anthropic-beta` is always sent regardless of whether `cache` is enabled. This is intentional — the beta header is harmless when caching is off, and omitting it when caching is on would silently discard all `cache_control` hints.

---

## call()

```ts
async call(req: NormalizedRequest): Promise<NormalizedResponse>
```

Non-streaming POST to `${baseUrl}/v1/messages`.

**Network error path:** Any exception thrown by `fetchFn` (connection refused, DNS failure, abort signal) is caught and re-thrown as `AdapterError` with `code: 'adapter.network'` and the original error as `cause`.

**HTTP error path:** On non-2xx, attempts `response.json()` to parse the error body. Navigates the shape `data.error.message` with full type-narrowing guards at each step. If any guard fails (no `error` key, `message` not present, JSON parse failure), falls back to the string `"Anthropic ${response.status}"`. Throws `AdapterError` with `code: adapter.http.${status}`.

**Success path:** Iterates `data.content` (always an array in the response):
- `block.type === 'text'`: concatenates `block.text` onto `content` string accumulator.
- `block.type === 'tool_use'`: pushes `{ id, name, arguments: block.input }` onto `toolCalls`.

**Usage mapping:** `cache_read_input_tokens` is included as `cached` only when it is both defined (`!== undefined`) and greater than zero. A value of 0 means no cache hit occurred; including it would be misleading.

**Return shape:**
```ts
{
  message: { role: 'assistant', content, toolCalls? },
  usage: { input, output, cached? },
  stopReason,
  raw: data,
}
```
`toolCalls` is omitted from `message` (not just empty) when the array is empty. `cached` is omitted from `usage` when there was no cache hit.

---

## parseSSE

```ts
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }>
```

Generator that reads a `ReadableStream<Uint8Array>` and yields parsed SSE events.

**Decoder:** `new TextDecoder()` with `{ stream: true }` passed to each `decode()` call. The `stream: true` option tells the decoder to hold incomplete multi-byte UTF-8 sequences across chunk boundaries rather than replacing them with the replacement character. Without it, code points split across two network chunks would be corrupted.

**Buffering:** Maintains a `buffer` string. Each decoded chunk is appended to `buffer`, then split on `'\n\n'` (the SSE event separator). `parts.pop()` removes and saves the last element back to `buffer` — it may be an incomplete event that hasn't received its terminating `\n\n` yet. Complete parts are processed immediately.

**Event parsing:** Each complete part is split on `'\n'`. Lines prefixed `'event: '` set `event` (`.slice(7).trim()`). Lines prefixed `'data: '` set `data` (`.slice(6)` — no trim, preserving any meaningful leading whitespace in JSON). An event is yielded only when both `event` and `data` are non-empty strings.

**Cleanup:** `reader.releaseLock()` in a `finally` block ensures the stream reader is always released, even if the caller breaks out of the `for await` loop early.

---

## stream()

```ts
async *stream(req: NormalizedRequest): AsyncIterable<StreamChunk>
```

Streaming POST. Network error handling and HTTP error handling are identical to `call()`. After a successful response, checks that `response.body` is non-null (throws `AdapterError('No response body', { code: 'adapter.network' })` if absent).

**State tracked across events:**
- `toolStash: Map<number, { index, id, name, args }>` — accumulates partial JSON for in-progress tool calls, keyed by the Anthropic content block index.
- `messageStartUsage: AnthropicUsage | undefined` — captured from `message_start`, holds input token counts including cache tokens.
- `messageDeltaUsage: { output_tokens: number } | undefined` — captured from `message_delta`, holds output token count.
- `finalStopReason` — updated from `message_delta.delta.stop_reason`, defaults to `'end_turn'`.

**SSE event lifecycle:**

`error`
: Parsed immediately. Throws `AdapterError` with `code: 'adapter.stream'` and the parsed object as `cause`. Uses `parsed.error?.message` with fallback `'Stream error'`.

`message_start`
: Parses `{ message: { usage: AnthropicUsage } }`. Stores the entire usage object as `messageStartUsage`. This is the only point where `cache_creation_input_tokens` and `cache_read_input_tokens` are available for streaming.

`content_block_start`
: Parses `{ index, content_block: { type, id?, name? } }`. If `content_block.type === 'tool_use'`, initializes a stash entry at `parsed.index` with `id`, `name`, and `args: ''`. Text blocks are ignored here (their content arrives in `content_block_delta`).

`content_block_delta`
: Parses `{ index, delta: { type, text?, partial_json? } }`.
- `text_delta`: yields `{ type: 'text', delta: parsed.delta.text }` immediately — text streams to the caller token by token.
- `input_json_delta`: looks up the stash entry by index and appends `parsed.delta.partial_json` to `stash.args`. Tool argument JSON is accumulated silently, not yielded until complete.

`content_block_stop`
: Parses `{ index }`. If a stash entry exists for that index:
1. JSON-parses `stash.args` into `parsedArgs`; falls back to `{}` on parse failure.
2. Yields `{ type: 'tool_call', call: { id, name, arguments: parsedArgs } }`.
3. Removes the entry from `toolStash`.

The tool call is emitted as a complete unit — callers never see partial tool calls.

`message_delta`
: Parses `{ delta: { stop_reason? }, usage: { output_tokens } }`. Stores `parsed.usage` as `messageDeltaUsage`. Updates `finalStopReason` if `delta.stop_reason` is present.

`message_stop`
: Synthesizes the final two chunks:
1. `{ type: 'usage', usage: { input, output, cached? } }` — `input` from `messageStartUsage.input_tokens`, `output` from `messageDeltaUsage.output_tokens`, `cached` from `messageStartUsage.cache_read_input_tokens` only if defined and > 0.
2. `{ type: 'end', reason: mapStopReason(finalStopReason) }`.

These are always the last two chunks yielded. The caller can rely on `end` being the terminal event.
