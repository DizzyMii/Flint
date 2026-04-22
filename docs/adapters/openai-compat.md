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
| `baseUrl`        | `string`                     | Yes      | Base URL of the OpenAI-compatible endpoint (no trailing slash)     |
| `apiKey`         | `string`                     | No       | Bearer token sent as `Authorization: Bearer <key>`. Omit for local servers that do not require auth |
| `defaultHeaders` | `Record<string, string>`     | No       | Extra headers merged into every request — useful for provider-specific auth schemes or versioning headers |
| `fetch`          | `typeof globalThis.fetch`    | No       | Custom fetch implementation                                        |

## Capabilities

| Capability         | Supported |
| ------------------ | --------- |
| Streaming          | Yes       |
| Tool use           | Yes       |
| Parallel tools     | Yes       |
| Prompt caching     | No        |
| Structured output  | Yes       |
| Vision (images)    | Provider-dependent |
| Token counting     | Provider-dependent |

> Prompt caching is not supported because it is an Anthropic-specific feature.
> Individual providers may offer their own caching mechanisms; consult their docs.

## Zero Runtime Dependencies

`@flint/adapter-openai-compat` has no npm runtime dependencies. It uses the
platform's native `fetch` (or a custom implementation you supply via the `fetch`
option) and types re-exported from the core `flint` package.

## openAICompatAdapter() options

```ts
function openAICompatAdapter(options: {
  apiKey: string;
  baseURL: string;
  defaultHeaders?: Record<string, string>;
}): ProviderAdapter
```

## Provider-specific configurations

**OpenAI:**
```ts
openAICompatAdapter({ apiKey: process.env.OPENAI_API_KEY!, baseURL: 'https://api.openai.com/v1' })
```

**Groq (fast inference):**
```ts
openAICompatAdapter({ apiKey: process.env.GROQ_API_KEY!, baseURL: 'https://api.groq.com/openai/v1' })
// Note: Groq has aggressive rate limits on free tier
```

**Together AI:**
```ts
openAICompatAdapter({ apiKey: process.env.TOGETHER_API_KEY!, baseURL: 'https://api.together.xyz/v1' })
```

**DeepSeek:**
```ts
openAICompatAdapter({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: 'https://api.deepseek.com/v1' })
```

**Ollama (local):**
```ts
openAICompatAdapter({ apiKey: 'ollama', baseURL: 'http://localhost:11434/v1' })
// apiKey is required by the adapter but not validated by Ollama
```

## Capabilities

```ts
adapter.capabilities = {
  streaming: true,
  toolCalling: true,   // supported by most OpenAI-compat providers
  vision: false,       // varies by provider
  cost: false,         // most providers don't report cost
  promptCaching: false,
};
```

Cost and caching are not reported — `maxDollars` budgets won't trigger with this adapter.

## See Also

- [Anthropic Adapter](./anthropic.md)
- [Writing an Adapter](./custom.md)
- [FAQ: Does Flint support local models?](/guide/faq#does-flint-support-local-models)
- Source: `packages/adapter-openai-compat/src/index.ts`
