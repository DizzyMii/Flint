# call()

Send a single request to an LLM and get a typed response.

`call()` is the lowest-level non-streaming request primitive. It applies optional compression, checks budget, calls the adapter, optionally validates the response against a schema, and returns a `Result`.

## Signature

```ts
function call<T = unknown>(options: CallOptions<T>): Promise<Result<CallOutput<T>>>
```

## CallOptions

```ts
type CallOptions<T = unknown> = {
  // Required
  adapter: ProviderAdapter;
  model: string;
  messages: Message[];

  // Optional — schema validation
  schema?: StandardSchemaV1<unknown, T>;

  // Optional — budget enforcement
  budget?: Budget;

  // Optional — message compression
  compress?: Transform;

  // Optional — pass-through to adapter
  tools?: Tool[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  cache?: 'auto' | 'off';

  // Optional — observability
  logger?: Logger;
  signal?: AbortSignal;
};
```

| Option | Type | Required | Description |
|---|---|---|---|
| `adapter` | `ProviderAdapter` | Yes | The LLM provider adapter |
| `model` | `string` | Yes | Model identifier (e.g. `'claude-opus-4-7'`) |
| `messages` | `Message[]` | Yes | Conversation history |
| `schema` | `StandardSchemaV1` | No | Validate response as JSON against this schema |
| `budget` | `Budget` | No | Enforce step/token/dollar limits |
| `compress` | `Transform` | No | Transform messages before sending |
| `tools` | `Tool[]` | No | Available tools for this call |
| `maxTokens` | `number` | No | Maximum response tokens |
| `temperature` | `number` | No | Sampling temperature |
| `stopSequences` | `string[]` | No | Stop generation at these sequences |
| `cache` | `'auto' \| 'off'` | No | Prompt caching mode — `'auto'` places cache breakpoints automatically, `'off'` disables them |
| `logger` | `Logger` | No | Debug/info/warn/error logger |
| `signal` | `AbortSignal` | No | Cancellation signal |

## CallOutput

```ts
type CallOutput<T = unknown> = {
  message: Message & { role: 'assistant' };
  value?: T;       // populated when schema is provided and response is valid JSON
  usage: Usage;
  cost?: number;
  stopReason: StopReason;
};
```

## Return value

`Promise<Result<CallOutput<T>>>` — never throws. On failure, returns `{ ok: false, error: Error }`.

Common error types:
- `AdapterError` — network or API error from the provider
- `BudgetExhausted` — budget limit hit before or after the call
- `ParseError` — response content was not valid JSON (when `schema` is set)
- `ValidationError` — response JSON did not match the schema

## Examples

### Basic call

```ts
import { call } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'What is 2 + 2?' }],
});

if (res.ok) {
  console.log(res.value.message.content); // "4"
  console.log(res.value.usage);           // { input: 12, output: 3 }
}
```

### With schema validation

```ts
import { call } from 'flint';
import * as v from 'valibot';

const SentimentSchema = v.object({
  label: v.picklist(['positive', 'negative', 'neutral']),
  score: v.number(),
});

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [
    { role: 'system', content: 'Respond with JSON only.' },
    { role: 'user', content: 'Sentiment of: "I love this library!"' },
  ],
  schema: SentimentSchema,
});

if (res.ok && res.value.value) {
  console.log(res.value.value.label); // "positive"
}
```

### With budget

```ts
import { call } from 'flint';
import { budget } from 'flint/budget';

const b = budget({ maxTokens: 1000, maxDollars: 0.05 });

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Hello' }],
  budget: b,
});
```

## CallOptions reference

```ts
type CallOptions<T = unknown> = {
  // Required
  adapter: ProviderAdapter;
  model: string;
  messages: Message[];

  // Output schema — forces JSON response and validates against schema
  schema?: StandardSchemaV1<unknown, T>;

  // LLM call parameters
  tools?: Tool[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  cache?: CacheControl;

  // Flint features
  budget?: Budget;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
};
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `adapter` | `ProviderAdapter` | required | The LLM provider adapter |
| `model` | `string` | required | Model identifier (e.g. `'claude-opus-4-7'`) |
| `messages` | `Message[]` | required | Conversation history |
| `schema` | `StandardSchemaV1` | — | Validates response as JSON against schema. Sets `output.value` on success. |
| `tools` | `Tool[]` | — | Tools available for this call |
| `maxTokens` | `number` | — | Max output tokens (provider default if unset) |
| `temperature` | `number` | — | Sampling temperature 0-1 |
| `stopSequences` | `string[]` | — | Stop generation when any sequence is encountered |
| `cache` | `CacheControl` | — | Explicit cache control (adapter-specific) |
| `budget` | `Budget` | — | Budget to consume for this call |
| `compress` | `Transform` | — | Message transform applied before sending |
| `logger` | `Logger` | — | Receives debug/info/warn/error log entries |
| `signal` | `AbortSignal` | — | Cancels the request when aborted |

## CallOutput reference

```ts
type CallOutput<T = unknown> = {
  message: Message & { role: 'assistant' };
  value?: T;           // populated when schema is set and validation passes
  usage: Usage;        // { input, output, cached? } token counts
  cost?: number;       // USD cost (populated if adapter reports it)
  stopReason: StopReason; // 'end' | 'tool_call' | 'max_tokens' | 'stop_sequence'
};
```

## StopReason values

| Value | Meaning |
|-------|---------|
| `'end'` | Model finished naturally |
| `'tool_call'` | Model wants to call a tool — check `message.toolCalls` |
| `'max_tokens'` | Hit `maxTokens` limit or provider max |
| `'stop_sequence'` | Hit one of `stopSequences` |

## Schema validation

When `schema` is set, `call()`:
1. Expects the model response to be valid JSON
2. Parses the JSON
3. Validates against the schema
4. Returns `{ ok: false, error: ValidationError }` if validation fails, or `{ ok: false, error: ParseError }` if the response isn't JSON

```ts
import * as v from 'valibot';

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Return JSON: { "score": 0-10 }' }],
  schema: v.object({ score: v.number() }),
});

if (res.ok) {
  console.log(res.value.value?.score); // typed as number
}
```

::: warning Schema validation applies after tool calls
If `stopReason === 'tool_call'`, schema validation is skipped — the message contains tool calls, not JSON output.
:::

## Common mistakes

::: warning Don't access res.value without checking res.ok first
`res.value` is only defined when `res.ok === true`. TypeScript enforces this, but be careful with type assertions.
:::

::: tip Use compress to manage context window costs
Pass a `compress` transform to trim redundant messages before they're sent. See [Compress & Pipeline](/features/compress).
:::

## See also

- [stream()](/primitives/stream) — streaming variant
- [agent()](/primitives/agent) — multi-step tool-calling loop
- [Budget](/features/budget) — step/token/dollar limits
- [Error Types](/reference/errors) — AdapterError, ValidationError, ParseError
