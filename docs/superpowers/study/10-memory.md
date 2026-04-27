**Source:** `packages/flint/src/memory.ts`

**See also:** Doc 08 (compress/summarize — the pipeline analog)

---

## `messages()`

Simple factory returning a `Messages` object backed by a private `Message[]` closure. No class, no prototype — the store is inaccessible except through the returned interface, enforcing controlled mutation.

**`replace(index, message)`** — silently no-ops on out-of-range index:

```ts
replace(index, m) {
  if (index < 0 || index >= store.length) return;
  store[index] = m;
}
```

Returns `void` in both the valid and invalid cases. No throw, no `Result` — the design treats an out-of-range replace as a caller mistake that shouldn't crash agent loops. Callers that need to know whether the replace landed must bounds-check before calling.

**`all()`** — returns a spread copy (`[...store]`), not the live array. This is the canonical pattern across all three exports: the internal store is never handed out directly, so external code cannot accidentally mutate agent history by holding a reference.

**`slice(from, to?)`** — delegates straight to `Array.prototype.slice`, including its semantics for negative indices and out-of-range bounds. No additional guard layer.

**`clear()`** — sets `store.length = 0`, mutating in place rather than reassigning. The closure captures the array reference once at creation time; any code that captured the same reference (for example, in tests) would still see the old data if `store` were reassigned to a new `[]`. Mutating in place makes the behavior unambiguous regardless of how the reference is used.

Design rationale: `messages()` is intentionally minimal. It does not model roles, enforce ordering, or apply any LLM-specific logic. It is raw storage. The richer semantics live in `conversationMemory()`.

---

## `scratchpad()`

Append-only string store backed by a `string[]` closure. The type (`Scratchpad`) exposes three methods: `note(text)`, `notes()`, and `clear()`.

`note(text)` pushes a raw string onto the array — no timestamp, no metadata. Each call adds one entry. This is intentionally lower-fidelity than `messages()`: scratchpad entries are not `Message` objects and are never sent to a model directly.

`notes()` returns `[...store]` — a spread copy, same defensive pattern as `messages().all()`.

**Use case.** Agent reasoning notes that accumulate across turns but do not belong in the conversation history sent to the LLM. Examples: intermediate chain-of-thought strings, tool-call rationale, bookkeeping the agent wants to refer back to without polluting the model's context window. The scratchpad is read by agent code, not by adapters.

The separation from `messages()` is intentional: mixing reasoning notes with conversation history creates noise in summarization and compress pipelines, and sends unnecessary tokens to the model on every turn.

---

## `conversationMemory()`

The stateful sliding-window memory primitive. Wraps a `Message[]` store and an async summarizer to keep context within a token budget without exposing truncation to callers.

### Options

```ts
type ConversationMemoryOpts = {
  max: number;
  summarizeAt: number;
  summarizer: (messages: Message[]) => Promise<string>;
};
```

- **`max`** — a configuration parameter used to compute `keepCount = max - summarizeAt`. It does not directly represent the post-summarize store size. The post-summarize store has `1 + (max - summarizeAt)` entries: one injected summary message plus `keepCount` kept messages. For example, with `max: 20, summarizeAt: 15`, `keepCount = 5`, and the post-summarize store has 6 entries (1 summary + 5 kept messages).
- **`summarizeAt`** — the threshold length at which the next `append` triggers summarization. Must be `< max` for the math to work; the library does not enforce this but the formula breaks if `summarizeAt >= max`.
- **`summarizer`** — caller-supplied async callback. The library is model-agnostic here; the caller wires in whatever LLM call they want (typically using the `call` primitive from Doc 06). This is the inversion-of-control point: `conversationMemory` owns the trigger and the store mutation, the caller owns the actual summarization logic.

### `append` trigger mechanic

```ts
async append(m) {
  store.push(m);
  if (store.length >= opts.summarizeAt) {
    // summarize
  }
}
```

The check fires **after** the new message is pushed. The incoming message is always in the store before any summarization decision. Summarization is synchronous in control flow (it `await`s before returning), so callers that `await append(m)` will see the post-summarize state on the next `messages()` call.

> **Type mismatch footgun.** The `ConversationMemory` type declares `append(m: Message): void`, but the implementation is `async append(m)`, making its actual return type `Promise<void>`. TypeScript will not warn about unawaited calls. Always `await append(m)` — an unawaited call will still push the message but may read a pre-summarization store on the very next operation, because the summarization callback has not yet completed.

### What gets summarized vs what gets kept

```ts
const keepCount = opts.max - opts.summarizeAt;
const toSummarize = store.slice(0, store.length - keepCount);
const kept = store.slice(store.length - keepCount);
```

`keepCount` is the number of messages that survive the summarization cycle verbatim. Its formula (`max - summarizeAt`) encodes the relationship between the two thresholds: the difference between the maximum allowed size and the point at which summarization fires determines how much recent history is preserved as raw messages. A small difference means fewer recent messages are kept; a large difference means more.

**Concrete example.** With `max: 20, summarizeAt: 15`, `keepCount = 5`. At trigger time, the store has 15 messages. `toSummarize = messages.slice(0, 10)` (the first 10 messages). `kept = messages.slice(-5)` (the last 5). Post-summarize store: `[summaryMessage, ...kept]` — 6 total entries.

`toSummarize` is everything except the tail `keepCount` messages — all older messages, including any previous summary message injected by a prior cycle.

`kept` is the tail — the most recent `keepCount` messages, preserved as-is without passing through the summarizer.

After the summarizer resolves, the store is rebuilt:

```ts
const summaryMessage: Message = {
  role: 'system',
  content: `Summary of prior conversation: ${text}`,
};
store.length = 0;
store.push(summaryMessage, ...kept);
```

The store is atomically replaced: zeroed, then repopulated with the summary message followed by kept messages. The result is a store of exactly `1 + keepCount` entries.

### Why `role: 'system'` for the summary

Two reasons:

1. **Semantic signal to the model.** A `system` role message reads as background context or instructions, not as a conversational turn. The model treats it as grounding information rather than as part of the dialogue, which is the correct framing for a condensed history summary.

2. **Compatibility with the compress pipeline.** Doc 08's `summarize` transform (and compress's `alwaysKeep` option) can be configured with `alwaysKeep: ['system']`. If a `conversationMemory` store is later fed through the compress pipeline, the injected summary message survives truncation automatically — it will never be dropped because it carries the `system` role. This is a design-level coupling between the two systems: `conversationMemory` uses `system` specifically so that downstream compress passes treat the summary as sacrosanct.

### Fail-open on summarizer error

```ts
try {
  const text = await opts.summarizer(toSummarize);
  latestSummary = text;
  // rebuild store
} catch {
  // fail-open: leave store unchanged, do not store summary
}
```

If the summarizer rejects (network error, rate limit, model failure), the catch block swallows the error. The store is left exactly as it was after the push — `summarizeAt` messages or more, unsummarized. `latestSummary` is not updated. The agent continues with the full history.

This is a deliberate availability-over-correctness tradeoff. An agent that crashes because its memory compaction failed is less useful than one that temporarily holds more history than intended. The failure mode is graceful: the store grows past `summarizeAt` until the next successful summarization cycle.

Callers that need to surface summarizer failures must wrap `append` or pass a summarizer that handles its own errors and returns a fallback string.

### `summary()` accessor

Returns `latestSummary: string | undefined`. `undefined` until at least one summarization cycle completes successfully. Useful for debugging, logging, and for callers that want to inject the summary elsewhere (e.g., into a system prompt outside the sliding window). The accessor reflects the last successful summary regardless of how many failed cycles occurred after it.

### `clear()`

Zeros the store and resets `latestSummary` to `undefined`. Unlike `messages().clear()`, this also resets the summary state — both halves of the internal state are cleared together, which is the correct behavior for starting a fresh conversation session.
