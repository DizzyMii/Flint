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

## See also

- [stream()](/primitives/stream) — streaming variant
- [agent()](/primitives/agent) — multi-step loop that calls `call()` internally
- [Budget](/features/budget) — budget limits and enforcement
- [Compress & Pipeline](/features/compress) — message transforms
