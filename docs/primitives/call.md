# call()

Send a single request to an LLM and get a typed response.

`call()` is the lowest-level non-streaming request primitive. It applies optional compression, runs budget pre-flight, calls the adapter (retrying transient failures), computes cost, optionally validates the response against a schema, and returns a `Result`.

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

  // Structured output
  schema?: StandardSchemaV1<unknown, T>;
  jsonSchema?: Record<string, unknown>;

  // Passed to the adapter
  tools?: Tool[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  cache?: 'auto' | 'off';
  extra?: Record<string, unknown>;

  // Flint features
  budget?: Budget;
  budgetSteps?: number;
  compress?: Transform;
  retry?: RetryPolicy | false;
  onRetry?: (info: RetryInfo) => void;
  logger?: Logger;
  signal?: AbortSignal;
};

type RetryPolicy = { retries?: number; baseDelayMs?: number; maxDelayMs?: number };
type RetryInfo = { attempt: number; error: AdapterError; delayMs: number };
```

| Option | Type | Default | Description |
|---|---|---|---|
| `adapter` | `ProviderAdapter` | required | The LLM provider adapter |
| `model` | `string` | required | Model identifier (e.g. `'claude-opus-5-5'`) |
| `messages` | `Message[]` | required | Conversation history |
| `schema` | `StandardSchemaV1` | — | Parse the response as JSON and validate it. Sets `output.value`. |
| `jsonSchema` | `object` | — | JSON Schema for the response. Adapters with native structured output constrain decoding with it. |
| `tools` | `Tool[]` | — | Tools available for this call |
| `maxTokens` | `number` | adapter default | Max output tokens. Budget pre-flight may lower it. |
| `temperature` | `number` | — | Sampling temperature |
| `stopSequences` | `string[]` | — | Stop generation at these sequences |
| `cache` | `'auto' \| 'off'` | adapter default | Prompt caching mode. The Anthropic adapter treats an unset value as `'auto'`. |
| `extra` | `object` | — | Provider-specific body fields merged into the request, e.g. `{ thinking: { type: 'adaptive' } }` |
| `budget` | `Budget` | — | Step/token/dollar limits, enforced before and after the call |
| `budgetSteps` | `number` | `1` | Steps charged to the budget. Use `0` for auxiliary calls such as summarization. |
| `compress` | `Transform` | — | Transform messages before sending |
| `retry` | `RetryPolicy \| false` | 2 retries | Retry transient provider failures. `false` disables. |
| `onRetry` | `(info) => void` | — | Called before each retry sleep |
| `logger` | `Logger` | — | Debug/info/warn/error logger |
| `signal` | `AbortSignal` | — | Cancels the request and any pending retry sleep |

## CallOutput

```ts
type CallOutput<T = unknown> = {
  message: AssistantMessage;
  value?: T;            // set when `schema` is provided and validation passed
  usage: Usage;
  cost?: number;        // USD, from the adapter or computed from adapter.pricing()
  stopReason: StopReason;
  sent?: Message[];     // the messages actually sent, after compression
};

type AssistantMessage = {
  role: 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  thinking?: ThinkingBlock[];        // reasoning blocks, when the provider returns them
  providerContent?: ProviderContent; // verbatim provider blocks, replayed on the next turn
};
```

### Usage

```ts
type Usage = {
  input: number;       // uncached input tokens only
  output: number;
  cached?: number;     // tokens read from the prompt cache
  cacheWrite?: number; // tokens written to the prompt cache
};
```

`input`, `cached` and `cacheWrite` are **disjoint**: the full prompt size is `input + (cached ?? 0) + (cacheWrite ?? 0)`. Each is billed at its own rate.

### StopReason values

| Value | Meaning |
|-------|---------|
| `'end'` | Model finished naturally |
| `'tool_call'` | Model wants to call a tool — check `message.toolCalls` |
| `'max_tokens'` | Hit `maxTokens` (possibly clamped by the budget) or the provider max |
| `'stop_sequence'` | Hit one of `stopSequences` |
| `'refusal'` | The model declined to answer |

## Return value

`Promise<Result<CallOutput<T>>>` — never throws for provider or budget failures. On failure, returns `{ ok: false, error }`. It throws `TypeError` only when `adapter`, `model` or `messages` is missing.

| Error | Code | When |
|---|---|---|
| `AdapterError` | `adapter.*` | Provider or network failure (after retries) |
| `BudgetExhausted` | `budget.steps` / `budget.tokens` / `budget.dollars` | Budget already exhausted, or the prompt leaves no room for output, or spend went over the limit |
| `FlintError` | `budget.unpriced` | `maxDollars` is set but nothing could price the call |
| `FlintError` | `compress.malformed` | `compress` returned a transcript a provider would reject |
| `FlintError` | `call.refusal` | `schema` is set and the model refused |
| `ParseError` | `parse.response_json` | `schema` is set and the response is not JSON |
| `ValidationError` | `validation.failed` | The JSON did not match `schema` |

See [Error Types](/reference/errors) for the full list.

## Examples

### Basic call

```ts
import { call } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const res = await call({
  adapter,
  model: 'claude-opus-5-5',
  messages: [{ role: 'user', content: 'What is 2 + 2?' }],
});

if (res.ok) {
  console.log(res.value.message.content); // "4"
  console.log(res.value.usage);           // { input: 12, output: 3 }
  console.log(res.value.cost);            // computed from the adapter's price table
}
```

### Structured output

Pass `schema` to parse and validate the reply. Pass `jsonSchema` as well to let adapters with native structured output constrain decoding (the Anthropic adapter sends it as `output_config.format`). Flint does not derive `jsonSchema` from `schema`; supply both.

```ts
import { call } from 'flint';
import * as v from 'valibot';

const Sentiment = v.object({
  label: v.picklist(['positive', 'negative', 'neutral']),
  score: v.number(),
});

const res = await call({
  adapter,
  model: 'claude-opus-5-5',
  messages: [{ role: 'user', content: 'Sentiment of: "I love this library!"' }],
  schema: Sentiment,
  jsonSchema: {
    type: 'object',
    properties: {
      label: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
      score: { type: 'number' },
    },
    required: ['label', 'score'],
    additionalProperties: false,
  },
});

if (res.ok && res.value.value) {
  console.log(res.value.value.label); // "positive"
}
```

Without native structured output, parsing is tolerant: Flint first tries the whole reply as JSON, then the contents of a ```` ```json ```` fence, then the span from the first `{`/`[` to the last `}`/`]`. A reply with `stopReason: 'refusal'` fails with `call.refusal` instead of a parse error. Schema handling is skipped when `stopReason === 'tool_call'`.

### With a budget

```ts
import { call } from 'flint';
import { budget } from 'flint/budget';

const b = budget({ maxTokens: 1000, maxDollars: 0.05 });

const res = await call({
  adapter,
  model: 'claude-opus-5-5',
  messages: [{ role: 'user', content: 'Hello' }],
  budget: b,
});
```

Before sending, `call()` estimates the prompt, lowers `max_tokens` to what the remaining tokens and dollars can buy, and refuses with `BudgetExhausted` if the prompt alone does not fit — without calling the provider. It holds a reservation while the request is in flight. See [Budget](/features/budget#what-a-call-does-with-the-budget).

### Provider-specific fields

`extra` is merged into the provider request body. Use it for features Flint does not model, such as extended thinking:

```ts
const res = await call({
  adapter,
  model: 'claude-opus-5-5',
  messages,
  extra: { thinking: { type: 'adaptive' } },
});
// res.value.message.thinking holds the reasoning blocks
```

## Retries

`call()` retries errors whose `AdapterError.retryable` is `true` — rate limits, overload, 5xx, timeouts, network failures. Non-retryable errors (bad request, auth, not found, context overflow, aborts) return immediately.

- Default: 2 retries after the first attempt.
- Delay: the provider's `retry-after` when present (capped at 60s), otherwise exponential backoff from `baseDelayMs` (500ms) capped at `maxDelayMs` (30s), with jitter.
- Aborting `signal` cancels a pending retry sleep.

```ts
const res = await call({
  adapter,
  model: 'claude-opus-5-5',
  messages,
  retry: { retries: 4, baseDelayMs: 1000 },
  onRetry: ({ attempt, error, delayMs }) =>
    console.warn(`retry ${attempt} in ${delayMs}ms: ${error.kind}`),
});

// Disable retries entirely:
await call({ adapter, model: 'claude-opus-5-5', messages, retry: false });
```

## Compression safety

When `compress` is set and the original transcript was well-formed, `call()` checks the transformed transcript with `checkTranscript()`. If the transform orphaned a tool result, dropped one, or left a tool call unanswered, the call fails with `compress.malformed` before anything is sent. See [Compress & Pipeline](/features/compress#turn-atomicity).

## callStream()

`callStream()` is the streaming form of `call()`: an async generator that yields `StreamChunk`s and **returns** the same `Result<CallOutput>`. It shares pre-flight, cost, budget and schema handling with `call()`. See [stream()](/primitives/stream#callstream).

## Common mistakes

::: warning Don't access res.value without checking res.ok first
`res.value` is only defined when `res.ok === true`. TypeScript enforces this, but be careful with type assertions.
:::

::: tip Use compress to manage context window costs
Pass a `compress` transform to trim redundant messages before they're sent. For long agent runs prefer a [context manager](/features/context), which keeps the cached prefix stable.
:::

## See also

- [stream()](/primitives/stream) — streaming variants
- [agent()](/primitives/agent) — multi-step tool-calling loop
- [Budget](/features/budget) — pre-flight, reservations, pricing
- [Error Types](/reference/errors) — AdapterError, ValidationError, ParseError
