# Anthropic Adapter

Connects Flint to Claude models via the Anthropic Messages API. Supports streaming,
tool use, vision, and prompt caching — and ships with zero runtime dependencies.

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
  model: 'claude-opus-4-5',
  messages: [{ role: 'user', content: 'Hello!' }],
});

if (result.ok) {
  console.log(result.value.message.content);
}
```

## Constructor Options

| Option    | Type                   | Required | Description                                                         |
| --------- | ---------------------- | -------- | ------------------------------------------------------------------- |
| `apiKey`  | `string`               | Yes      | Your Anthropic API key (`ANTHROPIC_API_KEY`)                        |
| `baseUrl` | `string`               | No       | Override the API base URL (default: `https://api.anthropic.com`)    |
| `fetch`   | `typeof globalThis.fetch` | No    | Custom fetch implementation — useful in environments without native fetch |

## Prompt Caching

Anthropic's prompt caching reduces cost and latency by reusing previously processed
tokens. The adapter enables caching at the beta header level on every request.

To activate cache breakpoints, pass `cache: 'auto'` on the normalized request. When
`cache` is `'auto'`, the adapter automatically places an `ephemeral` cache-control
marker on:

- The last system message block
- The last tool definition

This covers the most common cache-worthy content. Tokens reused from cache appear
in `usage.cached` on the response.

```ts
const result = await call({
  adapter,
  model: 'claude-opus-4-5',
  messages: [
    { role: 'system', content: longSystemPrompt },
    { role: 'user', content: 'Summarize the document.' },
  ],
  cache: 'auto',   // place ephemeral breakpoints automatically
});

if (result.ok) {
  console.log(result.value.usage.cached); // number of tokens served from cache
}
```

Caching is most effective for long, stable system prompts and large tool lists that
remain unchanged across many calls. Cache entries have a five-minute TTL on
Anthropic's side.

## Capabilities

| Capability         | Supported |
| ------------------ | --------- |
| Streaming          | Yes       |
| Tool use           | Yes       |
| Parallel tools     | Yes       |
| Prompt caching     | Yes       |
| Structured output  | Yes       |
| Vision (images)    | Yes       |
| Token counting     | Yes — via `usage.input` / `usage.cached` on every response |

## Zero Runtime Dependencies

`@flint/adapter-anthropic` has no npm runtime dependencies. It communicates with the
Anthropic API using the platform's native `fetch` (or a custom implementation you
supply via the `fetch` option), and uses types re-exported from the core `flint`
package.

## See Also

- [OpenAI-Compatible Adapter](./openai-compat.md)
- [Writing an Adapter](./custom.md)
- [Anthropic Messages API reference](https://docs.anthropic.com/en/api/messages)
- Source: `packages/adapter-anthropic/src/index.ts`
