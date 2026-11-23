# Context Management

Keep a long agent run inside the model's context window without throwing away the prompt cache.

```ts
import { contextManager, compactionDecision } from 'flint/context';
```

`contextManager()` is a stateful `ContextStrategy` you pass to `agent({ context })`. It summarizes old history **rarely** — when the window is filling up, when the provider rejects the prompt as too long, or when the arithmetic says summarizing is cheaper than re-reading — and otherwise sends a prompt that only ever grows at the end, so the provider cache keeps hitting.

## Why not compress on every request?

With prompt caching, a provider bills history it has seen before at a fraction of the input price (0.1× on Anthropic by default). That only works if the prompt's **prefix** is byte-identical to the previous request. A per-request transform such as `windowLast()` or `summarize()` changes the start of the prompt on every call, so each request pays to write a new cache entry instead of reading the old one.

`contextManager()` avoids that: between compactions the prompt is

```
[leading system messages] + [summary system message, if any] + transcript[upto..]
```

A compaction is a single committed event that moves `upto` forward on a turn boundary. The request that compacts pays one cache write for the new prefix; every request after it reads that prefix from cache again.

## Usage

```ts
import { agent } from 'flint';
import { budget } from 'flint/budget';
import { contextManager } from 'flint/context';
import { anthropicAdapter, anthropicPricing } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const context = contextManager({
  summarizer: { adapter, model: 'claude-opus-5-5', maxTokens: 2000 },
  contextWindow: 200_000,
  pricing: anthropicPricing['claude-opus-5-5']!, // enables economic compaction
});

const out = await agent({
  adapter,
  model: 'claude-opus-5-5',
  messages,
  tools,
  budget: budget({ maxSteps: 200, maxDollars: 20 }),
  context,
  onEvent: (e) => {
    if (e.type === 'compaction') console.log('compacted', e.record.reason, e.record.compactedTokens);
  },
});
```

The summarizer can be a cheaper model than the working model. Its calls go through `call()` with the agent's budget and `budgetSteps: 0`, so they cost tokens and dollars but not steps.

## Options

```ts
type ContextManagerOptions = {
  summarizer: { adapter: ProviderAdapter; model: string; maxTokens?: number };
  contextWindow: number;
  highWater?: number;
  keepRecentTokens?: number;
  pricing?: ModelPricing;
  horizon?: (info: ContextInfo) => number;
  minCompactTokens?: number;
  count?: (messages: Message[]) => number;
  restore?: CompactionRecord;
  promptPrefix?: string;
  logger?: Logger;
};
```

| Option | Default | Description |
|---|---|---|
| `summarizer` | required | Adapter and model that write the summary. `maxTokens` caps the summary (default 2000). |
| `contextWindow` | required | The working model's context window, in tokens |
| `highWater` | `0.8` | Compact when the prompt exceeds this fraction of the window |
| `keepRecentTokens` | `min(20_000, contextWindow / 4)` | Most recent history always kept verbatim |
| `pricing` | — | Working-model pricing. Enables economic compaction; without it only window pressure (and overflow) compacts. |
| `horizon` | budget's remaining steps, else 8 | Expected number of further requests that will re-send the prompt |
| `minCompactTokens` | `4096` | Never compact a span smaller than this for economic reasons |
| `count` | built-in estimate | Token counter for messages |
| `restore` | — | Resume from a `CompactionRecord` (e.g. from an event log) |
| `promptPrefix` | built-in | Instructions given to the summarizer |
| `logger` | — | Receives a warning when summarization fails |

The returned object also has a read-only `state` property: the current `CompactionRecord`, or `undefined`.

## When it compacts

On each `prepare()` call (once per agent step) the manager:

1. Builds the current view and estimates its size.
2. Finds the **cut**: the latest turn boundary after the previous cut that still leaves at least `keepRecentTokens` of history after it. If there is none, nothing happens.
3. Picks a reason, in this order:
   - **`forced`** — the agent passes `force: true` after the provider rejected the prompt as too long (`AdapterError` kind `context_overflow`). The tail requirement drops to zero, and the agent retries the step once.
   - **`pressure`** — the view exceeds `highWater × contextWindow`.
   - **`economics`** — `pricing` is set, the span is at least `minCompactTokens`, and `compactionDecision()` says compacting is cheaper.
4. Summarizes `transcript[upto..cut]` (plus the previous summary, if any) and commits a new record.

If the summarizer call fails or returns nothing, the manager logs a warning and sends the uncompacted view; the run continues.

```ts
type CompactionRecord = {
  upto: number;              // transcript index (exclusive) replaced by `summary`
  summary: string;
  reason: 'pressure' | 'economics' | 'forced';
  compactedTokens: number;   // tokens removed from the prompt
  summaryTokens: number;
  projectedSavings?: number; // expected $ saving over the horizon, when pricing is known
};
```

Each compaction is emitted as an agent `compaction` event. The summary is inserted as a system message (`Summary of earlier work in this session: …`) directly after the leading system messages; the agent's own transcript (`AgentOutput.messages`) is never rewritten.

### Restoring after a restart

The manager's state is just the last record. Persist it from the event log and pass it back as `restore`:

```ts
import { readFile } from 'node:fs/promises';
import { agent, parseEventLog, transcriptFrom } from 'flint';

const events = parseEventLog(await readFile('run.jsonl', 'utf8'));
const last = events.filter((e) => e.type === 'compaction').at(-1);

const context = contextManager({
  summarizer: { adapter, model: 'claude-opus-5-5' },
  contextWindow: 200_000,
  ...(last?.type === 'compaction' ? { restore: last.record } : {}),
});

await agent({ adapter, model: 'claude-opus-5-5', messages: transcriptFrom(events), tools, budget: b, context });
```

A restored record whose `upto` lies beyond the transcript is discarded.

## compactionDecision(): the cost model

```ts
function compactionDecision(x: CompactionInput): CompactionDecision;

type CompactionInput = {
  compactable: number;   // tokens that would be summarized
  tail: number;          // tokens kept verbatim after the cut
  horizon: number;       // expected further requests that re-send the prompt
  pricing: ModelPricing; // working model
  summarizerPricing?: ModelPricing; // defaults to `pricing`
  summaryTokens: number; // expected summary length
};

type CompactionDecision = { compact: boolean; keepCost: number; compactCost: number };
```

It compares two futures over the next `horizon` requests. With per-token rates (`$/MTok ÷ 1e6`), `read` and `write` the working model's cache-read and cache-write rates, and `in` / `out` the summarizer's input and output rates:

**Keep** — every future request reads the compactable span from cache:

```
keepCost = horizon × compactable × read
```

**Compact** — pay the summarizer once (full input plus the summary it writes), pay once to re-write the new prefix (summary + tail) to cache instead of reading it, then read only the summary on every future request:

```
compactCost = compactable × in
            + summaryTokens × out
            + (summaryTokens + tail) × (write − read)
            + horizon × summaryTokens × read
```

The tail is read from cache in both futures, so it cancels out of the comparison. `compact` is `true` when `compactCost < keepCost`.

### Why the answer is usually "keep"

Plug in `claude-opus-5-5` list prices ($4 input, $20 output, $0.20 cache read, $5 cache write per MTok):

| Span summarized | Tail | Horizon | Summary | keepCost | compactCost | Decision |
|---|---|---|---|---|---|---|
| 20k | 5k | 5 | 1.5k | $0.020 | $0.143 | keep |
| 100k | 20k | 28 | 2k | $0.560 | $0.557 | ≈ break-even |
| 400k | 5k | 200 | 2k | $16.00 | $1.75 | compact |

Summarizing costs the full input price for the whole span once, while keeping it costs a tenth of that per request. Compaction only pays off for large spans that will be re-read many more times. That is the point of the function: **compaction is a cost decision, not a reflex.** With caching on, the main reason to compact is to stay inside the context window.

## Benchmark (simulated)

`packages/adapter-anthropic/test/bench.test.ts` runs a scripted 30-step tool-using agent on `claude-opus-5-5` against a **simulated** Anthropic endpoint that bills the way the prompt cache does (prefix hashes written at breakpoints, a 20-block lookback, token counts approximated from block JSON). The model's behaviour is fixed, so the differences come only from what Flint sends.

| Mode | Requests | Cost | Uncached input | Cache read | Cache write |
|---|---|---|---|---|---|
| No caching (`cache: 'off'`) | 31 | $3.08 | 748,271 | 0 | 0 |
| Legacy layout (tools + system breakpoints only) | 31 | $2.56 | 604,462 | 139,170 | 4,639 |
| Rolling layout (current default) | 31 | **$0.45** | 0 | 704,050 | 44,221 |
| Rolling + `contextManager` (40k window) | 38 | $0.73 | 0 | 364,061 | 113,016 |

Numbers observed by running `npx vitest run test/bench.test.ts` in `packages/adapter-anthropic`. They come from a simulator, not from the API; use them to compare layouts, not to predict a bill.

Reading the last row: the artificially small 40k window forces repeated `pressure` compactions (seven extra summarizer requests). Each one re-writes the cache, so the run halves the tokens read but costs more than caching alone. That is the expected trade: the context manager keeps the prompt inside the window, and with a well-cached prompt it should rarely fire for economic reasons.

## Writing your own strategy

`agent({ context })` accepts any `ContextStrategy`:

```ts
interface ContextStrategy {
  prepare(
    transcript: Message[],
    info: ContextInfo,
  ): Promise<{ messages: Message[]; compaction?: CompactionRecord }>;
}

type ContextInfo = { model: string; step: number; budget?: Budget; force?: boolean };
```

`transcript` is the full history; return the messages to send. Return `compaction` to have the agent emit a `compaction` event. When `info.force` is true the previous attempt overflowed the window and the agent will retry once with whatever you return.

## See also

- [Compress & Pipeline](/features/compress) — stateless per-request transforms
- [Anthropic adapter](/adapters/anthropic#prompt-caching) — the rolling cache layout
- [Event log & resume](/features/events) — `compaction` events
- [Budget](/features/budget) — pricing and `budgetSteps`
