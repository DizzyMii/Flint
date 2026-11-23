# stream()

Send a request to an LLM and receive chunks as they arrive.

Flint has two streaming primitives:

| | `stream()` | `callStream()` |
|---|---|---|
| Shape | `AsyncIterable<StreamChunk>` | `AsyncGenerator<StreamChunk, Result<CallOutput>>` |
| Errors | Thrown from the iterator | Returned as a `Result` |
| Retries | No | Yes, but only before the first chunk |
| Schema validation | No | Yes (`schema`, like `call()`) |
| Final message | Assemble it yourself | Returned in `CallOutput` |

Both run the same budget pre-flight as [`call()`](/primitives/call): `max_tokens` is clamped to what the budget can pay for, a reservation is held while streaming, and a prompt that alone exceeds the budget is refused before the provider is contacted.

## stream()

```ts
function stream(options: StreamOptions): AsyncIterable<StreamChunk>

type StreamOptions = {
  // Required
  adapter: ProviderAdapter;
  model: string;
  messages: Message[];

  // Optional
  tools?: Tool[];
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  cache?: 'auto' | 'off';
  extra?: Record<string, unknown>;
  budget?: Budget;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
};
```

Throws `TypeError` if `adapter`, `model` or `messages` is missing. Pre-flight failures (`BudgetExhausted`, `compress.malformed`) and adapter errors are thrown from the iterator — use `try`/`catch`.

### Example

```ts
import { stream } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

for await (const chunk of stream({
  adapter,
  model: 'claude-opus-5-5',
  messages: [{ role: 'user', content: 'Write a haiku about TypeScript.' }],
})) {
  if (chunk.type === 'text') process.stdout.write(chunk.delta);
  if (chunk.type === 'usage') console.log('\nTokens:', chunk.usage, 'cost:', chunk.cost);
}
```

### Budget consumption

When the `usage` chunk arrives, `stream()` releases the reservation, computes `cost` (from the chunk, or from `adapter.pricing(model)`), charges the budget, and yields the chunk with `cost` filled in. If that charge exceeds a limit, the iterator throws `BudgetExhausted`.

```ts
import { BudgetExhausted } from 'flint/errors';

const b = budget({ maxTokens: 1000 });
try {
  for await (const chunk of stream({ adapter, model, messages, budget: b })) {
    if (chunk.type === 'text') process.stdout.write(chunk.delta);
  }
} catch (err) {
  if (err instanceof BudgetExhausted) console.log('Token limit reached');
}
```

`stream()` does not fail closed on unpriced `maxDollars` budgets and does not retry. Use `callStream()` when you want `call()` semantics.

## callStream()

```ts
function callStream<T = unknown>(
  options: CallOptions<T>,
): AsyncGenerator<StreamChunk, Result<CallOutput<T>>>
```

Takes the same options as [`call()`](/primitives/call) — including `schema`, `retry`, `onRetry` and `budgetSteps` — and yields chunks as they arrive. The generator's **return value** is the same `Result<CallOutput>` that `call()` would produce.

Retryable errors are retried only if they happen **before the first chunk** is yielded, so a consumer never sees duplicated output. A failure after streaming has started is returned as `{ ok: false }`.

```ts
import { callStream } from 'flint';
import type { CallOutput, Result } from 'flint';

const it = callStream({ adapter, model: 'claude-opus-5-5', messages });
let result: Result<CallOutput> | undefined;
while (!result) {
  const n = await it.next();
  if (n.done) result = n.value;
  else if (n.value.type === 'text') process.stdout.write(n.value.delta);
}

if (result.ok) console.log('\n', result.value.usage, result.value.cost);
```

`agent({ streaming: true })` uses `callStream()` internally and re-emits each chunk as a `chunk` [event](/features/events).

## StreamChunk

```ts
type StreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage; cost?: number }
  | { type: 'message'; message: AssistantMessage }
  | { type: 'end'; reason: StopReason };
```

| Chunk type | When emitted | Key fields |
|------------|-------------|-----------|
| `text` | Each text fragment | `delta` |
| `thinking` | Each reasoning fragment (extended thinking) | `delta` |
| `tool_call` | When a tool call's arguments are complete | `call` — `{ id, name, arguments, parseError? }` |
| `usage` | After generation completes | `usage` — `{ input, output, cached?, cacheWrite? }`, `cost?` |
| `message` | Before `end`, from adapters that can supply it | `message` — the fully assembled `AssistantMessage`, including `thinking` and `providerContent` |
| `end` | Last chunk | `reason` — `'end'`, `'tool_call'`, `'max_tokens'`, `'stop_sequence'` or `'refusal'` |

A `tool_call` whose streamed arguments were not valid JSON carries `parseError`; `agent()` answers it with an error result instead of running the tool.

## Assembling a response

`assembleStream()` folds chunks into a `NormalizedResponse`. When the adapter emits a `message` chunk, that exact message is used (so thinking signatures survive); otherwise the text and tool calls are concatenated.

```ts
import { assembleStream, stream } from 'flint';

const acc = assembleStream();
for await (const chunk of stream({ adapter, model, messages })) acc.push(chunk);
const { message, usage, stopReason } = acc.response();
```

## Cancellation with AbortSignal

```ts
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);

try {
  for await (const chunk of stream({ adapter, model, messages, signal: controller.signal })) {
    if (chunk.type === 'text') process.stdout.write(chunk.delta);
  }
} finally {
  clearTimeout(timeout);
}
```

## See also

- [call()](/primitives/call) — non-streaming variant
- [Event log](/features/events) — `agent({ streaming: true })` emits `chunk` events
- [Budget](/features/budget) — pre-flight and reservations
- [Error Types](/reference/errors) — AdapterError, BudgetExhausted
