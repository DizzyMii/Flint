# OpenAI-Compatible Adapter

A generic adapter for any provider that exposes an OpenAI-compatible Chat Completions
API. Works out of the box with OpenAI, Groq, Together AI, DeepSeek, Fireworks, Mistral,
Perplexity, Ollama (local), and any other server that speaks the same wire format.

## Install

```bash
npm install @flint/adapter-openai-compat
```

## Usage

### OpenAI

```ts
import { openaiCompatAdapter } from '@flint/adapter-openai-compat';
import { call } from 'flint';

const adapter = openaiCompatAdapter({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: 'https://api.openai.com/v1',
});

const result = await call({
  adapter,
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});

if (result.ok) {
  console.log(result.value.message.content);
}
```

### Groq

```ts
import { openaiCompatAdapter } from '@flint/adapter-openai-compat';
import { call } from 'flint';

const adapter = openaiCompatAdapter({
  apiKey: process.env.GROQ_API_KEY,
  baseUrl: 'https://api.groq.com/openai/v1',
});

const result = await call({
  adapter,
  model: 'llama-3.3-70b-versatile',
  messages: [{ role: 'user', content: 'Hello!' }],
});

if (result.ok) {
  console.log(result.value.message.content);
}
```

### Ollama (local)

```ts
import { openaiCompatAdapter } from '@flint/adapter-openai-compat';
import { call } from 'flint';

const adapter = openaiCompatAdapter({
  // No apiKey required for local Ollama
  baseUrl: 'http://localhost:11434/v1',
});

const result = await call({
  adapter,
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Hello!' }],
});

if (result.ok) {
  console.log(result.value.message.content);
}
```

## Constructor Options

| Option           | Type                         | Required | Description                                                        |
| ---------------- | ---------------------------- | -------- | ------------------------------------------------------------------ |
| `baseUrl`        | `string`                     | Yes      | Base URL of the OpenAI-compatible endpoint (a trailing slash is stripped) |
| `apiKey`         | `string`                     | No       | Bearer token sent as `Authorization: Bearer <key>`. Omit for local servers that do not require auth |
| `defaultHeaders` | `Record<string, string>`     | No       | Extra headers merged into every request — useful for provider-specific auth schemes or versioning headers |
| `extraBody`      | `Record<string, unknown>`    | No       | Body fields merged into every request (e.g. `{ seed: 1 }`). Per-request `extra` is merged after it and wins |
| `pricing`        | `PriceTable \| (model: string) => ModelPricing \| undefined` | No | Per-model prices in USD per million tokens. Enables `cost` and `maxDollars` budgets — see [Pricing and budgets](#pricing-and-budgets) |
| `fetch`          | `typeof globalThis.fetch`    | No       | Custom fetch implementation                                        |

### Provider base URLs

| Provider    | `baseUrl`                          |
| ----------- | ---------------------------------- |
| OpenAI      | `https://api.openai.com/v1`        |
| Groq        | `https://api.groq.com/openai/v1`   |
| Together AI | `https://api.together.xyz/v1`      |
| DeepSeek    | `https://api.deepseek.com/v1`      |
| Ollama      | `http://localhost:11434/v1`        |

## Capabilities

| Capability         | Supported |
| ------------------ | --------- |
| Streaming          | Yes       |
| Tool use           | Yes       |
| Parallel tools     | Yes       |
| Prompt caching     | No explicit control (automatic provider caching is reported in `usage.cached`) |
| Structured output  | Yes (`response_format: json_schema`) |
| Vision (images)    | Provider-dependent |
| Token counting     | No (Flint falls back to an approximate count) |

`capabilities.defaultMaxTokens` is not set: the adapter sends `max_tokens` only when you pass
`maxTokens`, so without it the server's own default applies.

## Pricing and budgets

This adapter ships **no built-in price table**: the same model id can cost different amounts on
Groq, Together, Fireworks or a local Ollama server, so any default would be wrong somewhere. Pass
your provider's prices to get `cost` on every response and to use `maxDollars`:

```ts
import { openaiCompatAdapter } from '@flint/adapter-openai-compat';
import { call } from 'flint';
import { budget } from 'flint/budget';

const adapter = openaiCompatAdapter({
  apiKey: process.env.GROQ_API_KEY,
  baseUrl: 'https://api.groq.com/openai/v1',
  pricing: {
    // USD per million tokens. Keys match exactly, then by longest substring of the model id.
    'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  },
});

const res = await call({
  adapter,
  model: 'llama-3.3-70b-versatile',
  messages: [{ role: 'user', content: 'Hello!' }],
  budget: budget({ maxDollars: 0.5 }),
});
if (res.ok) console.log(res.value.cost);
```

`pricing` may also be a function `(model) => ModelPricing | undefined` if you load prices from
elsewhere. `cacheRead` defaults to 10% of `input`; set it explicitly for providers that discount
cached tokens differently (OpenAI's cached-input discount varies by model). For a
local server, `{ input: 0, output: 0 }` makes `maxDollars` budgets usable.

**Without pricing, `maxDollars` fails closed.** If a budget has `maxDollars` and the adapter has
no price for the model, `call()` returns an error with code `budget.unpriced` instead of spending
untracked money. Either pass `pricing` or drop `maxDollars` (token and step limits still work).

## Usage semantics

`usage.input` counts **uncached** prompt tokens only. OpenAI's `prompt_tokens` includes
`prompt_tokens_details.cached_tokens`, so the adapter reports:

| Flint field    | Source                                                                |
| -------------- | --------------------------------------------------------------------- |
| `usage.input`  | `prompt_tokens - cached_tokens`                                       |
| `usage.cached` | `prompt_tokens_details.cached_tokens` (or DeepSeek's `prompt_cache_hit_tokens`); omitted when 0 |
| `usage.output` | `completion_tokens`                                                   |

Streaming requests send `stream_options: { include_usage: true }` so the final chunk carries
usage. If a server rejects that field, drop it with `extra: { stream_options: undefined }`.

## Structured output

When `call()` receives `jsonSchema`, the adapter sends:

```json
{ "response_format": { "type": "json_schema", "json_schema": { "name": "response", "schema": { "...": "..." }, "strict": true } } }
```

OpenAI's strict mode requires every property to be listed in `required` and
`additionalProperties: false` on every object. Servers without `json_schema` support may reject the
request; omit `jsonSchema` (Flint still validates the reply against `schema`) or override the field
via `extra`.

## Tool calls and refusals

- If a model emits tool-call arguments that are not valid JSON, the call is returned with
  `arguments: {}` and `parseError` set to the JSON error. Flint's agent does not run the tool; it
  sends an error result back so the model can retry. Empty-string arguments are treated as `{}`.
- Tool results with `isError: true` are sent as normal `role: 'tool'` messages (the Chat
  Completions API has no error flag); Flint already prefixes the content with `Error: `.
- `finish_reason: 'content_filter'`, or a non-null `message.refusal`, maps to
  `stopReason: 'refusal'`. The refusal text becomes the message content.

## Provider-specific fields

Use `extraBody` for fields every request needs and `extra` on a single call for the rest. Both are
shallow-merged into the request body last, so they can override anything the adapter sets:

```ts
await call({ adapter, model: 'o3-mini', messages, extra: { reasoning_effort: 'high' } });
```

## Errors

HTTP failures throw an `AdapterError` with `code: 'adapter.http.<status>'`, the provider's
`error.message` as its message, and a classification:

| Condition                                        | `kind`             | `retryable` |
| ------------------------------------------------ | ------------------ | ----------- |
| 429                                              | `rate_limit`       | Yes         |
| 503                                              | `overloaded`       | Yes         |
| Other 5xx                                        | `server`           | Yes         |
| 408                                              | `timeout`          | Yes         |
| 401 / 403                                        | `auth`             | No          |
| 404                                              | `not_found`        | No          |
| 400 / 413 mentioning the context length          | `context_overflow` | No          |
| Other 4xx                                        | `invalid_request`  | No          |
| `fetch` threw                                    | `network` (`adapter.network`) | Yes |

`retry-after` / `retry-after-ms` response headers populate `retryAfterMs`. The adapter itself never
retries; `call()` retries retryable errors (twice by default, honouring `retryAfterMs`) — configure
it with the `retry` option.

## Zero Runtime Dependencies

`@flint/adapter-openai-compat` has no npm runtime dependencies. It uses the
platform's native `fetch` (or a custom implementation you supply via the `fetch`
option) and helpers from the core `flint` package.

## See Also

- [Anthropic Adapter](./anthropic.md)
- [Writing an Adapter](./custom.md)
- [FAQ: Does Flint support local models?](/guide/faq#does-flint-support-local-models)
- Source: `packages/adapter-openai-compat/src/index.ts`
