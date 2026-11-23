# Anthropic Adapter

Connects Flint to Claude models via the Anthropic Messages API. Supports streaming, tool use, vision, extended thinking, native structured output and prompt caching — with a built-in price table and zero runtime dependencies.

## Install

```bash
npm install @flint/adapter-anthropic
```

## Usage

```ts
import { anthropicAdapter } from '@flint/adapter-anthropic';
import { call } from 'flint';

const adapter = anthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const result = await call({
  adapter,
  model: 'claude-opus-5-5',
  messages: [{ role: 'user', content: 'Hello!' }],
});

if (result.ok) {
  console.log(result.value.message.content);
  console.log(result.value.usage, result.value.cost);
}
```

## Options

```ts
type AnthropicAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  pricing?: PriceTable | ((model: string) => ModelPricing | undefined);
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  defaultMaxTokens?: number;
};
```

| Option | Default | Description |
|---|---|---|
| `apiKey` | required | Your Anthropic API key, sent as `x-api-key` |
| `baseUrl` | `https://api.anthropic.com` | API base URL (proxies, gateways) |
| `fetch` | `globalThis.fetch` | Custom fetch implementation |
| `pricing` | built-in table | A table that overrides or extends `anthropicPricing` (looked up first, falling back to the built-in table), or a function that replaces it |
| `extraBody` | — | Fields merged into **every** request body, e.g. `{ thinking: { type: 'adaptive' } }` |
| `headers` | — | Extra HTTP headers (e.g. a beta flag). Applied after the defaults, so they can override them. |
| `defaultMaxTokens` | `16000` | `max_tokens` sent when a request does not set one. Also reported as `capabilities.defaultMaxTokens` for budget pre-flight. |

Requests are sent with `anthropic-version: 2023-06-01`. No prompt-caching beta header is needed or sent.

## Capabilities

```ts
adapter.capabilities = {
  promptCache: true,
  structuredOutput: true,
  parallelTools: true,
  defaultMaxTokens: 16000, // or your defaultMaxTokens
};
```

The adapter implements `pricing(model)` but not `count()`; Flint's budget pre-flight uses its own estimate and [calibrates it](/features/budget#self-calibrating-prompt-estimate) from the usage each response reports.

## Pricing

`anthropicPricing` is the built-in table of list prices in USD per million tokens. The adapter reports `cost` on every response from it, which is what makes `maxDollars` budgets work out of the box.

```ts
import { anthropicPricing } from '@flint/adapter-anthropic';
```

| Model | Input | Output | Cache read |
|---|---|---|---|
| `claude-fable-5-2`, `claude-mythos-5-2` | $8 | $40 | $0.20 |
| `claude-fable-5-1`, `claude-mythos-5-1` | $10 | $50 | $0.25 |
| `claude-fable-5` | $10 | $50 | 0.1× input |
| `claude-opus-5-5` | $4 | $20 | $0.20 |
| `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6` | $5 | $25 | 0.1× input |
| `claude-sonnet-5-5` | $2 | $10 | $0.10 |
| `claude-sonnet-5` | $2 | $10 | 0.1× input |
| `claude-sonnet-4-6` | $3 | $15 | 0.1× input |
| `claude-haiku-5-5` | $0.10 | $0.50 | 0.1× input |
| `claude-haiku-4-5` | $1 | $5 | 0.1× input |

Cache writes are billed at 1.25× input (5-minute TTL). `claude-haiku-5-5` switches to $0.50 / $2.50 (with cache rates scaled to match) once a request's prompt exceeds 100k tokens. Model ids are matched exactly first, then by the longest table key contained in the id, so dated or region-prefixed ids resolve too.

Override or extend the table when your contract prices differ or you use a model it does not list:

```ts
const adapter = anthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  pricing: { 'claude-opus-5-5': { input: 3.6, output: 18, cacheRead: 0.18 } },
});
```

If neither table prices the model, responses carry no `cost` and a `maxDollars` budget fails closed with `budget.unpriced`.

## Prompt caching

Caching is **on by default**: a request with `cache` unset is treated as `cache: 'auto'`. Pass `cache: 'off'` to send no breakpoints.

With `'auto'`, the adapter places up to four `cache_control: { type: 'ephemeral' }` breakpoints — the API maximum — in a **rolling layout** built for agent loops:

1. the last tool definition (caches all tools),
2. the last system block (caches the system prompt),
3. the **previous request's final user turn** — the user message just before the latest assistant reply. That is exactly where the previous request put its own last breakpoint, so this one reads it as an exact cache hit no matter how many blocks the latest turn added (the API only looks back 20 blocks from a breakpoint),
4. the **current final message** — written now so the next request can read it.

Every step of an agent run therefore reads the whole history from cache and pays full price only for the newest turn. Thinking blocks are never marked; the breakpoint goes on the last non-thinking block of a message.

Reported usage follows Flint's disjoint convention: `usage.input` is uncached input, `usage.cached` is `cache_read_input_tokens`, `usage.cacheWrite` is `cache_creation_input_tokens`.

```ts
const res = await call({ adapter, model: 'claude-opus-5-5', messages });
if (res.ok) {
  const { input, cached = 0, cacheWrite = 0 } = res.value.usage;
  console.log(`prompt ${input + cached + cacheWrite} tokens, ${cached} from cache`);
}
```

In a simulated 30-step agent benchmark the rolling layout cut cost from $2.56 (tools + system breakpoints only) to $0.45, against $3.08 with caching off. See the [benchmark table](/features/context#benchmark-simulated) for details and caveats.

::: tip Keep the prefix stable
The cache only hits when the prompt prefix is byte-identical to the previous request. Avoid per-request transforms that rewrite early history; use [`contextManager()`](/features/context) for long runs.
:::

## Extended thinking

Enable thinking through the request body, either per call with `extra` or for every request with `extraBody`:

```ts
const adapter = anthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  extraBody: { thinking: { type: 'adaptive' } },
});
```

Responses then carry `message.thinking` (`{ type: 'thinking', thinking, signature }` or `{ type: 'redacted_thinking', data }` blocks) and, when streaming, `thinking` chunks.

Thinking blocks are signed, and the API rejects a later request whose earlier assistant turns do not carry them back unchanged. The adapter handles this round-trip: any assistant message with thinking also gets `providerContent: { provider: 'anthropic', blocks }` — the exact content blocks the API returned — and when that message is sent back to Anthropic the adapter replays those blocks verbatim instead of rebuilding them. Keep assistant messages intact in the transcript (Flint's agent loop does) and tool use with thinking works across steps.

## Structured output

`call({ jsonSchema })` is sent as `output_config.format: { type: 'json_schema', schema }`, merged with any other `output_config` fields you pass in `extra`/`extraBody`. Combine it with `schema` to validate and type the result:

```ts
const res = await call({
  adapter,
  model: 'claude-opus-5-5',
  messages: [{ role: 'user', content: 'Extract the invoice total and currency.' }],
  schema: Invoice,              // Standard Schema, for validation and typing
  jsonSchema: invoiceJsonSchema, // JSON Schema, for constrained decoding
});
```

A response with `stop_reason: 'refusal'` maps to `stopReason: 'refusal'`; with `schema` set, `call()` returns `call.refusal` rather than a parse error.

## Tools

Tools are sent with `input_schema: tool.jsonSchema ?? { type: 'object' }` — always give tools a `jsonSchema`. Tool results go back as `tool_result` blocks, all results of one turn in a single user message, with `is_error: true` when the Flint tool message has `isError`.

When streaming, tool arguments are accumulated from `input_json_delta` events. If they do not parse as JSON, the `tool_call` chunk carries `parseError` and the agent answers with an error result instead of running the tool.

## Other request fields

`extra` (per call) and `extraBody` (per adapter) are merged into the body last, so they can set anything the Messages API accepts — `metadata`, `top_k`, `service_tier`, `tool_choice`, and so on. Per-call `extra` wins over `extraBody`.

```ts
await call({
  adapter,
  model: 'claude-opus-5-5',
  messages,
  tools,
  extra: { tool_choice: { type: 'any' } },
});
```

## Stop reasons

| Anthropic `stop_reason` | Flint `StopReason` |
|---|---|
| `end_turn` | `'end'` |
| `tool_use` | `'tool_call'` |
| `max_tokens` | `'max_tokens'` |
| `stop_sequence` | `'stop_sequence'` |
| `refusal` | `'refusal'` |
| anything else (e.g. `pause_turn`) | `'end'` |

## Errors

Every failure is a classified `AdapterError`, so `call()`'s retry logic knows what to do:

| Failure | Code | `kind` | Retryable |
|---|---|---|---|
| HTTP 429 | `adapter.http.429` | `rate_limit` | Yes |
| HTTP 529 / 503 | `adapter.http.529` / `.503` | `overloaded` | Yes |
| Other 5xx | `adapter.http.5xx` | `server` | Yes |
| HTTP 408 | `adapter.http.408` | `timeout` | Yes |
| HTTP 409 | `adapter.http.409` | `invalid_request` | Yes |
| HTTP 401 / 403 | `adapter.http.401` / `.403` | `auth` | No |
| HTTP 404 | `adapter.http.404` | `not_found` | No |
| HTTP 400 / 413 "prompt is too long" | `adapter.http.400` / `.413` | `context_overflow` | No |
| Other 4xx | `adapter.http.4xx` | `invalid_request` | No |
| fetch failed | `adapter.network` | `network` | Yes |
| request aborted | `adapter.aborted` | `network` | No |
| SSE `error` event | `adapter.stream` | `overloaded` / `rate_limit` / `server` | For overloaded, rate-limit and `api_error` |

`retry-after-ms` / `retry-after` headers populate `retryAfterMs`, and `x-should-retry` overrides `retryable`. The provider's error message becomes the error message; the status and parsed body are in `cause`. A `context_overflow` error makes `agent()` force a compaction and retry once when a [context manager](/features/context) is configured.

## Common mistakes

::: warning API key in source code
Never hardcode API keys. Use environment variables: `process.env.ANTHROPIC_API_KEY!`
:::

## See also

- [OpenAI-Compatible Adapter](./openai-compat.md)
- [Writing an Adapter](./custom.md)
- [Context management](/features/context) — benchmark and compaction economics
- [Anthropic Messages API reference](https://docs.anthropic.com/en/api/messages)
- Source: `packages/adapter-anthropic/src/index.ts`
