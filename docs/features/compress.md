# Compress & Pipeline

Reduce token count and shape message history before each LLM call.

A `Transform` is a function `(messages, ctx) => Promise<Message[]>`. Flint ships six built-in transforms. Combine them with `pipeline()`.

## Importing

```ts
import {
  pipeline,
  dedup,
  truncateToolResults,
  windowLast,
  windowFirst,
  summarize,
  orderForCache,
} from 'flint/compress';
```

## Transform type

```ts
type Transform = (messages: Message[], ctx: CompressCtx) => Promise<Message[]>;

type CompressCtx = {
  budget?: { remaining(): { tokens?: number } };
  model?: string;
};
```

## pipeline()

Compose transforms sequentially. Each transform receives the output of the previous one.

```ts
const compress = pipeline(
  dedup(),
  truncateToolResults({ maxChars: 2000 }),
  windowLast({ keep: 20 }),
);

const res = await call({ ..., compress });
```

## Built-in transforms

### dedup()

Remove duplicate messages (same role + content). System messages are always kept.

```ts
dedup(): Transform
```

### truncateToolResults(opts)

Truncate tool result messages that exceed `maxChars` characters.

```ts
truncateToolResults(opts: { maxChars: number }): Transform
```

`maxChars` must be > 50. Truncated messages get a suffix: `…[truncated, N chars dropped]`.

### windowLast(opts)

Keep only the last `keep` non-system messages, plus any messages matching `alwaysKeep` roles.

```ts
windowLast(opts: { keep: number; alwaysKeep?: Role[] }): Transform
```

### windowFirst(opts)

Keep only the first `keep` non-system messages, plus `alwaysKeep` roles.

```ts
windowFirst(opts: { keep: number; alwaysKeep?: Role[] }): Transform
```

### orderForCache()

Reorder messages to maximize prompt cache hit rate (system messages first, then history, then new user turn last). Use with prompt-cache-aware adapters.

```ts
orderForCache(): Transform
```

### summarize(opts)

Summarize older messages to reduce history length using an LLM call.

```ts
type SummarizeOpts = {
  when: (messages: Message[]) => boolean;
  adapter: ProviderAdapter;
  model: string;
  keepLast?: number;       // default: 4
  promptPrefix?: string;   // override the summarization prompt
};

summarize(opts: SummarizeOpts): Transform
```

`when` controls the trigger condition. `keepLast` controls how many recent messages are preserved in full after summarization.

## Example — full pipeline

```ts
import { pipeline, dedup, truncateToolResults, windowLast, orderForCache } from 'flint/compress';
import { agent } from 'flint';
import { budget } from 'flint/budget';

const compress = pipeline(
  dedup(),
  truncateToolResults({ maxChars: 4000 }),
  windowLast({ keep: 30, alwaysKeep: ['system'] }),
  orderForCache(),
);

const out = await agent({
  adapter,
  model: 'claude-opus-4-7',
  messages,
  tools,
  budget: budget({ maxSteps: 20, maxDollars: 1.00 }),
  compress,
});
```

## Writing a custom transform

```ts
import type { Transform } from 'flint/compress';

const redactSecrets: Transform = async (messages) => {
  return messages.map((msg) => ({
    ...msg,
    content: typeof msg.content === 'string'
      ? msg.content.replace(/sk-[a-z0-9]+/g, '[REDACTED]')
      : msg.content,
  }));
};
```

## See also

- [call()](/primitives/call) — accepts `compress` option
- [agent()](/primitives/agent) — applies compress before each step
- [Memory](/features/memory) — auto-summarizing conversation memory
- [Safety](/features/safety) — `redact()` for output redaction
