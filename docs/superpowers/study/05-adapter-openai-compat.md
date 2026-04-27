# 05 — Adapter: OpenAI-compat

**Source:** `packages/adapter-openai-compat/src/index.ts`
**See also:** Doc 04 (Anthropic adapter for contrast), Doc 03 (adapter contract)

---

## Internal OpenAI API types

All types are module-private — no exports.

**Content parts**

```ts
type OpenAITextContentPart      = { type: 'text'; text: string };
type OpenAIImageUrlContentPart  = { type: 'image_url'; image_url: { url: string } };
type OpenAIContentPart          = OpenAITextContentPart | OpenAIImageUrlContentPart;
```

The image variant carries a `url` string — used both for remote URLs and for inline data-URLs (`data:<mediaType>;base64,<data>`).

**Tool call (non-streaming)**

```ts
type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };  // arguments is a JSON *string*, not parsed
};
```

`arguments` is always a raw JSON string on the wire. Callers must `JSON.parse` it. This is the fundamental difference from Flint's `ToolCall.arguments`, which is `unknown` (already parsed).

**Message (4 role variants)**

```ts
type OpenAIMessage =
  | { role: 'system';    content: string }
  | { role: 'user';      content: string | OpenAIContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool';      content: string; tool_call_id: string };
```

Key constraints: assistant `content` can be `null` when `tool_calls` is present. Tool results are sent as individual `tool` role messages (not coalesced).

**Tool definition**

```ts
type OpenAITool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
```

The `type: 'function'` envelope is mandatory — OpenAI's envelope pattern differs from Anthropic, which sends tools as a flat array without a wrapping type discriminant.

**Request body**

```ts
type OpenAIRequestBody = {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  stream?: boolean;
};
```

No `cache_control`, no `system` top-level field, no `max_tokens` default (if omitted, the model decides).

**Usage**

```ts
type OpenAIUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
```

Field names differ from Anthropic (`input_tokens` / `output_tokens`). Flint maps them on the way out: `input: prompt_tokens`, `output: completion_tokens`. `total_tokens` is ignored.

**Non-streaming response**

```ts
type OpenAIResponse = {
  id: string; object: string; created: number; model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason: string;
  }>;
  usage: OpenAIUsage;
};
```

`choices` is an array — `call()` defensively checks for an empty array and throws `AdapterError` with code `adapter.parse`.

**Streaming delta tool call**

```ts
type OpenAIDeltaToolCall = {
  index: number;           // always present — identifies which tool call slot
  id?: string;             // only on first delta for that index
  type?: 'function';       // only on first delta
  function?: { name?: string; arguments?: string };  // arrive piecemeal
};
```

All fields except `index` are optional because they arrive across multiple chunks. The adapter accumulates them in a `Map<number, { id, name, args }>` keyed by `index`.

**Stream chunk**

```ts
type OpenAIStreamChunk = {
  id: string; object: string; created: number; model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string | null; tool_calls?: OpenAIDeltaToolCall[] };
    finish_reason: string | null;
  }>;
  usage?: OpenAIUsage | null;  // present on last chunk when stream_options.include_usage is set
};
```

`usage` is optional/nullable — it only appears on the final chunk when the provider includes usage in the stream.

---

## mapStopReason — and the stop ambiguity

```ts
function mapStopReason(reason: string | null | undefined): 'end' | 'tool_call' | 'max_tokens' {
  if (reason === 'tool_calls') return 'tool_call';
  if (reason === 'length')     return 'max_tokens';
  return 'end';
}
```

Three mappings:

| OpenAI `finish_reason` | Flint `stopReason` |
|---|---|
| `'tool_calls'` | `'tool_call'` |
| `'length'` | `'max_tokens'` |
| `'stop'` (and anything else, including `null`) | `'end'` |

**The stop ambiguity:** Anthropic distinguishes `end_turn` (natural completion) from `stop_sequence` (stop sequence matched). OpenAI collapses both into a single `'stop'` value. Flint maps `'stop'` to `'end'`, which means stop-sequence hits are indistinguishable from natural end-of-turn at the Flint layer. This is a documented limitation of the OpenAI-compat adapter — callers that need to detect stop-sequence matches cannot do so through this adapter.

---

## normalizeMessages — differences from Anthropic

**No system block extraction.** Anthropic's `normalizeMessages` skips system messages and returns them separately as `systemPrompt: string` for the top-level `system` field. Here, system messages pass through unchanged as `{ role: 'system', content }` inline in the messages array — because the OpenAI API has no top-level system field.

**Tool results are individual, not coalesced.** Anthropic's normalizer groups consecutive `tool` role messages into a single `user` turn with multiple `tool_result` content blocks. Here each `tool` message maps 1:1 to a `{ role: 'tool', content, tool_call_id }` object.

**Assistant tool calls — arguments must be JSON-stringified:**

```ts
function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
```

Flint's `ToolCall.arguments` is `unknown` (already parsed). The OpenAI wire format requires `arguments` as a raw JSON string, so `JSON.stringify` is mandatory here. The inverse is done in `call()` and `stream()` with `JSON.parse`.

**Images — data-URL encoding for inline images:**

```ts
// image_url type (remote):
{ type: 'image_url', image_url: { url: part.url } }

// image_b64 type (inline):
{ type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } }
```

Both Flint image variants collapse to `image_url` — OpenAI has no separate base64 type. Inline images are encoded as data-URLs with the `data:<mediaType>;base64,<data>` scheme.

**No cache_control.** The Anthropic normalizer emits `cache_control: { type: 'ephemeral' }` on content parts for prompt caching. This adapter omits it entirely (`capabilities.promptCache: false`).

---

## buildBody

```ts
function buildBody(req: NormalizedRequest, streaming: boolean): OpenAIRequestBody {
  const body: OpenAIRequestBody = { model: req.model, messages: normalizeMessages(req.messages) };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stopSequences && req.stopSequences.length > 0) body.stop = req.stopSequences;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description,
                  parameters: (t.jsonSchema ?? { type: 'object' }) as Record<string, unknown> },
    }));
  }
  if (streaming) body.stream = true;
  return body;
}
```

Key differences from Anthropic's `buildBody`:

- **No default `max_tokens`.** Anthropic requires `max_tokens` and defaults to `4096` if not set. Here `max_tokens` is omitted entirely when `req.maxTokens` is undefined — the model's own default applies.
- **No `cache_control` / cache fields.** Anthropic adds `cache_control` to system and content parts. Absent here.
- **Tools wrapped in `{ type: 'function', function: { ... } }` envelope.** Anthropic sends `{ name, description, input_schema }` directly. OpenAI requires the `type: 'function'` discriminant wrapper.
- **`jsonSchema ?? { type: 'object' }` fallback.** If the tool has no schema, an empty object schema is sent rather than omitting parameters.
- **`stream: true` injected for streaming.** Anthropic uses a separate header (`anthropic-beta`); here it's a body field.

---

## parseSSE — differences from Anthropic

```ts
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string | null; data: string }>
```

`event` is typed `string | null` — OpenAI SSE events rarely include an `event:` line; the field will be `null` for most chunks.

**`[DONE]` sentinel check:**

```ts
if (data === '[DONE]') break;
```

OpenAI terminates the stream with a `data: [DONE]` line rather than a final event type. The adapter breaks out of the SSE loop on this sentinel. Anthropic uses a `message_stop` event type for termination — no sentinel string.

**Buffer flush after stream close:**

```ts
// after the while loop:
if (buffer.trim()) {
  // parse and yield any remaining event
}
```

After the reader signals `done`, any unconsumed content in `buffer` (a chunk that arrived without a trailing `\n\n`) is parsed and yielded. The Anthropic adapter relies on the `\n\n` double-newline delimiter always being present before stream close and does not need this flush. OpenAI providers may not guarantee a trailing `\n\n` after `[DONE]`.

---

## throwHttpError helper

```ts
async function throwHttpError(response: Response, label: string): Promise<never>
```

Extracted as a standalone `async` function rather than inlined because it is called from both `call()` and `stream()` — two code paths that each need to surface HTTP errors before reading the response body.

Return type is `Promise<never>` — TypeScript understands this function always throws; callers after `await throwHttpError(...)` are unreachable and the compiler knows it. This avoids the need for explicit `return` statements after error-handling branches.

The error message prefers `response.body.error.message` from the parsed JSON if present, falling back to `"${label} ${response.status}"` (e.g., `"OpenAI-compat 429"`). The full parsed body is attached as `cause.body` on the `AdapterError`.

```ts
throw new AdapterError(msg, {
  code: `adapter.http.${response.status}`,  // e.g. 'adapter.http.429'
  cause: { status: response.status, body: errorBody },
});
```

---

## call()

Sends a single `POST /chat/completions` with `stream: false` (omitted from body).

**`choices[0]` guard:**

```ts
const choice = data.choices[0];
if (!choice) throw new AdapterError('Empty choices array', { code: 'adapter.parse' });
```

The OpenAI spec guarantees at least one choice for non-streaming responses, but the adapter guards anyway. Throws `adapter.parse` — not `adapter.http` — because the HTTP request succeeded but the payload is malformed.

**Tool arguments — parse with fallback:**

```ts
let parsedArgs: unknown = {};
try {
  parsedArgs = JSON.parse(tc.function.arguments);
} catch {
  parsedArgs = {};
}
```

`tc.function.arguments` is the raw JSON string from the wire. `JSON.parse` can fail if the model emits malformed JSON (observed in some fine-tuned models and edge cases). The fallback is `{}` rather than a throw, so partial tool calls surface with empty arguments instead of crashing the caller.

**Usage mapping:**

```ts
usage: { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
```

`total_tokens` is dropped — Flint's `Usage` type only tracks input and output separately.

---

## stream()

Sends `POST /chat/completions` with `stream: true` in the body.

**Tool stash — indexed by `delta.index`:**

```ts
type ToolStash = { id: string; name: string; args: string };
const toolStash = new Map<number, ToolStash>();
```

OpenAI streams tool call fields piecemeal across multiple chunks. The first delta for a given `index` typically carries `id` and `name`; subsequent deltas carry `arguments` fragments. The adapter:

1. Creates a stash entry on first encounter (`!toolStash.has(idx)`), initializing from whatever fields are present (`id ?? ''`, `function?.name ?? ''`, `args: ''`).
2. Conditionally overwrites `id` and `name` on later deltas if present (handles providers that split name across chunks).
3. Concatenates `function.arguments` fragments: `stash.args += tc.function.arguments`.

**Tool stash flushed after `[DONE]`, not on a content-block-stop event:**

```ts
if (data === '[DONE]') break;
// ... (end of for-await loop)

for (const [, stash] of toolStash) {
  let parsedArgs: unknown = {};
  try { parsedArgs = JSON.parse(stash.args); } catch { parsedArgs = {}; }
  yield { type: 'tool_call', call: { id: stash.id, name: stash.name, arguments: parsedArgs } };
}
```

The Anthropic adapter yields `tool_call` chunks on `content_block_stop` events during streaming, because each tool call is a discrete content block with explicit open/close events. OpenAI has no such per-tool lifecycle — the adapter must wait until `[DONE]` to know all argument fragments have arrived before parsing and yielding.

**Usage from the last chunk:**

```ts
if (chunk.usage) {
  promptTokens = chunk.usage.prompt_tokens;
  completionTokens = chunk.usage.completion_tokens;
}
```

Usage is read from any chunk that carries it (in practice the final chunk, when `stream_options.include_usage` is set by the provider). The values are accumulated in local variables and yielded after `[DONE]` along with the end chunk:

```ts
yield { type: 'usage', usage: { input: promptTokens, output: completionTokens } };
yield { type: 'end', reason: mapStopReason(finalFinishReason) };
```

If the provider does not send usage in the stream, both values remain `0` — callers must tolerate zero-usage in streaming mode.

**`finish_reason` accumulation:**

```ts
if (choice.finish_reason) finalFinishReason = choice.finish_reason;
```

`finish_reason` is `null` on all chunks except (typically) the last choice chunk. The adapter tracks the last non-null value and passes it to `mapStopReason` for the `end` chunk.
