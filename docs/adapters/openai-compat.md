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
import { FlintClient } from 'flint';

const client = new FlintClient({
  adapter: openaiCompatAdapter({
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: 'https://api.openai.com/v1',
  }),
});

const response = await client.call({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Groq

```ts
import { openaiCompatAdapter } from '@flint/adapter-openai-compat';
import { FlintClient } from 'flint';

const client = new FlintClient({
  adapter: openaiCompatAdapter({
    apiKey: process.env.GROQ_API_KEY,
    baseUrl: 'https://api.groq.com/openai/v1',
  }),
});

const response = await client.call({
  model: 'llama-3.3-70b-versatile',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Ollama (local)

```ts
import { openaiCompatAdapter } from '@flint/adapter-openai-compat';
import { FlintClient } from 'flint';

const client = new FlintClient({
  adapter: openaiCompatAdapter({
    // No apiKey required for local Ollama
    baseUrl: 'http://localhost:11434/v1',
  }),
});

const response = await client.call({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Hello!' }],
});
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

## See Also

- [Anthropic Adapter](./anthropic.md)
- [Writing an Adapter](./custom.md)
- Source: `packages/adapter-openai-compat/src/index.ts`
