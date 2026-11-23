# Compress & Pipeline

Reduce token count and shape message history before each LLM call.

A `Transform` is a function `(messages, ctx) => Promise<Message[]>`. Flint ships six built-in transforms. Combine them with `pipeline()` and pass the result as `compress` to `call()`, `stream()` or `agent()`.

::: tip Long agent runs: prefer a context manager
A transform runs on **every request** and rewrites the prompt each time. Anything it changes near the start of the transcript moves the cached prefix, so the next request pays full price for history it could have read from cache. For long agent loops use [`contextManager()`](/features/context): it compacts rarely, on a turn boundary, and keeps the prefix byte-identical between compactions. Use transforms for cheap, stable edits (truncating oversized tool output) and for one-shot `call()`s.
:::

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

## Turn atomicity

Providers reject a transcript in which a tool result has no matching tool call, a tool call has no result, or a result appears twice. Flint therefore treats a **turn** as the smallest unit a transform may keep or drop:

- an assistant message that has tool calls, together with the tool results answering those calls, or
- any other single message.

The built-in transforms respect this, and `call()` enforces it for custom ones: if the transcript was well-formed before `compress` and malformed after, the call fails with `FlintError` code **`compress.malformed`** without contacting the provider. The error's `cause` lists the problems.

The helpers are exported from `flint`:

```ts
import { toTurns, checkTranscript } from 'flint';

type Turn = { start: number; messages: Message[] };
type TranscriptIssue = { index: number; problem: string };

toTurns(messages);        // Turn[] — start is the index of the turn's first message
checkTranscript(messages); // TranscriptIssue[] — [] when well-formed
```

`checkTranscript()` allows a trailing assistant message with unanswered calls, since the caller is about to execute them.

## pipeline()

Compose transforms left to right. Each transform receives the output of the previous one.

```ts
const compress = pipeline(
  dedup(),
  truncateToolResults({ maxChars: 2000 }),
  windowLast({ keep: 20 }),
);

const res = await call({ ..., compress });
```

## Built-in transforms

| Transform | Description |
|-----------|-------------|
| `dedup()` | Drop repeated user/assistant text messages |
| `truncateToolResults({ maxChars })` | Truncate long tool results |
| `windowLast({ keep, alwaysKeep? })` | Keep the most recent whole turns |
| `windowFirst({ keep, alwaysKeep? })` | Keep the earliest whole turns |
| `summarize(opts)` | Replace older history with an LLM-written summary |
| `orderForCache()` | Move system messages to the front |

### dedup()

```ts
dedup(): Transform
```

Removes a user or assistant message whose role and content exactly match an earlier one. System messages, tool results and assistant messages with tool calls are **never** dropped — they are bound to call ids, and two identical results of different calls are both needed.

### truncateToolResults(opts)

```ts
truncateToolResults(opts: { maxChars: number }): Transform
```

Shortens tool results longer than `maxChars` and appends `…[truncated, N chars dropped]`. `maxChars` must be greater than 50. Messages are never removed, so the transcript stays well-formed. Because the result is deterministic, the prefix it produces is stable across requests and caches well.

### windowLast(opts) / windowFirst(opts)

```ts
type WindowOpts = { keep: number; alwaysKeep?: Role[] };  // alwaysKeep defaults to ['system']

windowLast(opts: WindowOpts): Transform
windowFirst(opts: WindowOpts): Transform
```

Keep at most `keep` messages (not counting pinned ones), taken from the end (`windowLast`) or the start (`windowFirst`) **in whole turns**. A tool-calling turn either fits entirely or is dropped entirely; the window stops at the first turn that does not fit, so it may keep fewer than `keep` messages. Standalone messages whose role is in `alwaysKeep` are always kept in their original position.

### summarize(opts)

```ts
type SummarizeOpts = {
  when: (messages: Message[]) => boolean;
  adapter: ProviderAdapter;
  model: string;
  keepLast?: number;       // default 4
  promptPrefix?: string;   // override the summarization prompt
};

summarize(opts: SummarizeOpts): Transform
```

When `when(messages)` is true, sends everything except the last `keepLast` messages to `model` and replaces it with one system message: `Summary of prior conversation: …`. The cut is moved back to a **turn boundary**, so a tool result is never separated from its call. If the summarizer call fails, the messages pass through unchanged.

::: warning summarize() runs on every matching request
`summarize()` is stateless: it calls the adapter directly (not through `call()`, so its spend is not charged to your budget) every time `when` is true, and its output changes the start of the prompt each time, which defeats prompt caching. For agent loops, [`contextManager()`](/features/context) does the same job once per compaction, charges the budget, and keeps the prefix stable.
:::

### orderForCache()

```ts
orderForCache(): Transform
```

Moves every system message to the front, keeping the relative order of the rest. Useful when system messages are interleaved and you want them inside the cached prefix.

## Example — full pipeline

```ts
import { pipeline, dedup, truncateToolResults, windowLast } from 'flint/compress';
import { call } from 'flint';

const compress = pipeline(
  dedup(),
  truncateToolResults({ maxChars: 4000 }),
  windowLast({ keep: 30 }),
);

const res = await call({ adapter, model: 'claude-opus-5-5', messages, compress });
```

## Writing a custom transform

Edit message content freely, but drop or reorder only whole turns — use `toTurns()` to find them.

```ts
import type { Transform } from 'flint/compress';

const redactSecrets: Transform = async (messages) =>
  messages.map((msg) =>
    typeof msg.content === 'string'
      ? ({ ...msg, content: msg.content.replace(/sk-[a-z0-9]+/g, '[REDACTED]') } as typeof msg)
      : msg,
  );
```

::: warning Assistant messages with providerContent
An assistant message that carries `providerContent` (for example a turn with extended thinking) is replayed to the same provider from those verbatim blocks, so edits to its `content` are not sent. Leave such messages untouched or drop them as whole turns.
:::

## See also

- [Context management](/features/context) — prefix-stable compaction for long runs
- [Memory](/features/memory) — higher-level memory with auto-summarization
- [call()](/primitives/call) — `compress` option and `compress.malformed`
- [agent()](/primitives/agent) — `compress` applies to every step
