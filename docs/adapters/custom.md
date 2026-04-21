# Writing an Adapter

An adapter is a thin translation layer between Flint's normalized request/response
types and a specific provider's HTTP API. Implementing the `ProviderAdapter`
interface is all that is required.

## ProviderAdapter Interface

```ts
// packages/flint/src/adapter.ts

export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  call(req: NormalizedRequest): Promise<NormalizedResponse>;
  stream(req: NormalizedRequest): AsyncIterable<StreamChunk>;
  count?(messages: Message[], model: string): number;  // optional
}
```

All fields:

| Member         | Type                                             | Required | Description                                                        |
| -------------- | ------------------------------------------------ | -------- | ------------------------------------------------------------------ |
| `name`         | `string`                                         | Yes      | Short identifier shown in errors and logs (e.g. `'my-provider'`)   |
| `capabilities` | `AdapterCapabilities`                            | Yes      | Declares what the provider supports                                |
| `call`         | `(req) => Promise<NormalizedResponse>`           | Yes      | Non-streaming request/response                                     |
| `stream`       | `(req) => AsyncIterable<StreamChunk>`            | Yes      | Streaming request — yields `StreamChunk` values                    |
| `count`        | `(messages, model) => number`                    | No       | Token counting; omit if the provider does not expose a count endpoint |

## AdapterCapabilities

```ts
export type AdapterCapabilities = {
  promptCache?: boolean;      // provider supports cache breakpoints
  structuredOutput?: boolean; // provider can enforce JSON schema output
  parallelTools?: boolean;    // provider can call multiple tools in one turn
};
```

All fields are optional and default to `false` when absent. Flint reads these flags
to decide which features to expose to calling code.

## NormalizedRequest

```ts
export type NormalizedRequest = {
  model: string;
  messages: Message[];
  tools?: Tool[];
  schema?: StandardSchemaV1;   // for structured output
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  cache?: 'auto' | 'off';      // 'auto' = place cache breakpoints
  signal?: AbortSignal;
};
```

Your `call` and `stream` implementations receive one of these. Map each field to
whatever the provider's API expects.

## NormalizedResponse

```ts
export type NormalizedResponse = {
  message: Message & { role: 'assistant' };
  usage: Usage;       // { input: number; output: number; cached?: number }
  cost?: number;      // optional computed cost in USD
  stopReason: StopReason; // 'end' | 'tool_call' | 'max_tokens' | 'stop_sequence'
  raw?: unknown;      // the raw provider response, for debugging
};
```

## StreamChunk

Your `stream` generator yields one of these union members:

```ts
export type StreamChunk =
  | { type: 'text';     delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage';    usage: Usage; cost?: number }
  | { type: 'end';      reason: StopReason };
```

Yield `'text'` chunks as they arrive, accumulate tool arguments until the tool
call is complete, then yield `'tool_call'`, and finally yield `'usage'` and
`'end'` after the stream closes.

## Minimal Implementation Example

```ts
import type {
  NormalizedRequest,
  NormalizedResponse,
  ProviderAdapter,
} from 'flint';
import type { StreamChunk } from 'flint';

export type MyAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export function myAdapter(opts: MyAdapterOptions): ProviderAdapter {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl ?? 'https://api.my-provider.com';

  return {
    name: 'my-provider',

    capabilities: {
      promptCache: false,
      structuredOutput: true,
      parallelTools: false,
    },

    async call(req: NormalizedRequest): Promise<NormalizedResponse> {
      const res = await fetchFn(`${base}/v1/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          max_tokens: req.maxTokens ?? 4096,
          temperature: req.temperature,
        }),
        ...(req.signal ? { signal: req.signal } : {}),
      });

      if (!res.ok) {
        throw new Error(`Provider error ${res.status}`);
      }

      const data = await res.json();

      return {
        message: {
          role: 'assistant',
          content: data.choices[0].message.content ?? '',
        },
        usage: {
          input: data.usage.prompt_tokens,
          output: data.usage.completion_tokens,
        },
        stopReason: data.choices[0].finish_reason === 'stop' ? 'end' : 'max_tokens',
        raw: data,
      };
    },

    async *stream(req: NormalizedRequest): AsyncIterable<StreamChunk> {
      // Stub — implement SSE parsing from the provider's streaming endpoint.
      // Yield { type: 'text', delta } for each text chunk.
      // Yield { type: 'usage', usage } once the stream ends.
      // Yield { type: 'end', reason } last.
      throw new Error('streaming not yet implemented');
    },
  };
}
```

## Testing

The simplest strategy is to mock `fetch` and verify the normalized output:

```ts
import { describe, expect, it, vi } from 'vitest';
import { myAdapter } from './index.ts';

const mockFetch = vi.fn();

const adapter = myAdapter({
  apiKey: 'test-key',
  fetch: mockFetch,
});

describe('myAdapter.call', () => {
  it('maps a successful response to NormalizedResponse', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });

    const result = await adapter.call({
      model: 'my-model',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.message.content).toBe('Hello!');
    expect(result.usage.input).toBe(10);
    expect(result.stopReason).toBe('end');
  });
});
```

Key things to verify:

- `stopReason` maps correctly for all provider finish reasons
- `usage.cached` is populated when the provider reports cache hits
- Tool calls are accumulated and emitted as `{ type: 'tool_call' }` stream chunks
- Non-2xx responses throw with a meaningful message (not a raw fetch error)

## See Also

- [Anthropic Adapter](./anthropic.md) — reference implementation
- [OpenAI-Compatible Adapter](./openai-compat.md)
- Source: [`packages/flint/src/adapter.ts`](../../packages/flint/src/adapter.ts)
- Source: [`packages/flint/src/types.ts`](../../packages/flint/src/types.ts)
- Source: [`packages/adapter-anthropic/src/index.ts`](../../packages/adapter-anthropic/src/index.ts)
