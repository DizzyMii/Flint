# stream()

Send a request to an LLM and receive chunks as they arrive via `AsyncIterable<StreamChunk>`.

`stream()` is the streaming counterpart to `call()`. It passes each chunk through as it arrives from the adapter, consuming budget on the `usage` chunk.

## Signature

```ts
function stream(options: StreamOptions): AsyncIterable<StreamChunk>
```

## StreamOptions

```ts
type StreamOptions = {
  // Required
  adapter: ProviderAdapter;
  model: string;
  messages: Message[];

  // Optional
  budget?: Budget;
  compress?: Transform;
  tools?: Tool[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  cache?: 'auto' | 'off';
  logger?: Logger;
  signal?: AbortSignal;
};
```

Same options as `call()` except `schema` is not available (parse the assembled text yourself after streaming).

## StreamChunk

```ts
type StreamChunk =
  | { type: 'text';     delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage';    usage: Usage; cost?: number }
  | { type: 'end';      reason: StopReason };
```

| Chunk type | When it appears | What to do |
|---|---|---|
| `text` | As text tokens arrive | Append `delta` to your buffer |
| `tool_call` | When the model calls a tool | Queue the call for execution |
| `usage` | Once, at end of response | Update budget, log telemetry |
| `end` | Final chunk | Check `reason` — `'end'`, `'tool_call'`, `'max_tokens'`, `'stop_sequence'` |

## Return value

`AsyncIterable<StreamChunk>` — iterate with `for await`. Throws `TypeError` if required options are missing.

## Example

```ts
import { stream } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

let text = '';

for await (const chunk of stream({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Write a haiku about TypeScript.' }],
})) {
  if (chunk.type === 'text') {
    process.stdout.write(chunk.delta);
    text += chunk.delta;
  }
  if (chunk.type === 'usage') {
    console.log('\nTokens:', chunk.usage);
  }
}
```

## See also

- [call()](/primitives/call) — non-streaming variant
- [agent()](/primitives/agent) — agent loop (uses `call()` internally, not `stream()`)
