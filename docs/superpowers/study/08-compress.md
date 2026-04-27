# 08 — The Compress Pipeline

**Source:** `packages/flint/src/compress.ts`
**See also:** Doc 06 (primitives — where pipeline is called), Doc 07 (budget.remaining in context), Doc 04 (orderForCache rationale)

## CompressCtx

```ts
export type CompressCtx = {
  budget?: { remaining(): { tokens?: number } };
  model?: string;
};
```

`CompressCtx` is the read-only context object threaded through every transform invocation. It carries two fields and both are optional, meaning the pipeline can run with zero context (useful in tests).

**`budget?.remaining()`** — The shape here is deliberately narrow: only `{ tokens?: number }` is required, not the full `BudgetRemaining` type from `budget.ts` (which also carries `steps` and `dollars`). Transforms care about token headroom specifically — a token-aware transform can inspect `ctx.budget?.remaining().tokens` and decide to compress more aggressively when headroom is low. The structural narrowing means any object with a `remaining()` method returning an object with an optional `tokens` number satisfies the contract; transforms don't import `Budget` directly. Who sets this field: the `call` and `stream` primitives in `primitives.ts` construct `CompressCtx` before running the pipeline, pulling the budget instance from the agent's runtime state and passing it in. If the caller did not configure a budget, the field is `undefined` and transforms must treat it as unbounded.

**`model?: string`** — Future-proofing for token-aware transforms. A transform that needs an exact token count (not just a character approximation) must pick the correct tokenizer, and tokenizers are model-specific. By threading `model` through `CompressCtx`, such a transform can select the right tokenizer without needing a separate parameter. None of the current built-in transforms use `model` — `dedup`, `truncateToolResults`, `windowLast`, `windowFirst`, and `orderForCache` all work on character lengths or structural properties. `summarize` receives `model` as part of its own `SummarizeOpts`, not from `CompressCtx`. The field is here so callers writing custom transforms can use it today without a context API change later.

## Transform type

```ts
export type Transform = (messages: Message[], ctx: CompressCtx) => Promise<Message[]>;
```

**Async even for sync transforms.** Every built-in transform except `summarize` is logically synchronous — `dedup` does a single pass, `windowLast` does a slice. They are all declared `async` and return `Promise<Message[]>`. The reason is `pipeline`'s implementation:

```ts
for (const t of transforms) {
  current = await t(current, ctx);
}
```

If transforms were allowed to be sync (`Message[] | Promise<Message[]>`), `pipeline` would need conditional logic — `Promise.resolve(t(...))` or an `instanceof Promise` check — or it would need to use `Promise.resolve` unconditionally and lose the ability to detect misuse. Making `Transform` uniformly `Promise<Message[]>` means `pipeline` can `await` every step identically. The cost is negligible: `async` functions return a pre-resolved microtask, not a new event loop tick.

**Returns new array, does not mutate.** Each transform returns a fresh `Message[]`. The caller's original `messages` array is never modified. This is referential integrity: the agent loop or primitive passes the same array to multiple consumers (logging, history tracking, the compress pipeline). If a transform mutated in place, the compressed array and the original array would be the same object, and logging before/after the pipeline would show the same mutated state. Returning a new array keeps the before-state observable and makes transforms composable without aliasing hazards.

## pipeline()

```ts
export function pipeline(...transforms: Transform[]): Transform {
  return async (messages, ctx) => {
    let current = messages;
    for (const t of transforms) {
      current = await t(current, ctx);
    }
    return current;
  };
}
```

`pipeline` is itself a `Transform` — a higher-order function that takes transforms and returns a transform with the same signature. This makes pipelines nestable: `pipeline(pipeline(a, b), c)` is valid, though unusual.

**Left-fold, sequential.** The loop is a strict left-fold: each transform receives the output of the previous one. This is not accidental — the transforms are chosen for their composability. `dedup` then `windowLast` produces a different result than `windowLast` then `dedup` (windowing first discards messages, dedup then has fewer candidates). The order the caller passes to `pipeline(...)` is the order of application.

**Why not parallel.** Parallelizing the transforms is not possible — the input to transform N+1 is the output of transform N. But even setting aside data dependency, parallelism would be wrong for `summarize`: `summarize` makes a live LLM call. If a pipeline contained two `summarize` transforms (unusual but valid), running them in parallel would fire two concurrent LLM calls against context that has already been partially reduced by the first summarize. Sequential execution ensures each transform sees a consistent, fully-reduced message list.

## dedup

```ts
export function dedup(): Transform {
  return async (messages) => {
    const seen = new Set<string>();
    const result: Message[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        result.push(msg);
        continue;
      }
      const contentKey =
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const key = `${msg.role}:${contentKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(msg);
    }
    return result;
  };
}
```

**System messages always pass through.** The dedup rule does not apply to `role === 'system'`. System messages are typically configuration or injected instructions. If two system messages have identical content, they were probably both intentional (e.g. a base system prompt plus a per-call addendum that happens to repeat text). Silently dropping one would change model behavior. Treating system messages as unconditionally kept is the conservative choice.

**Content key construction.** For `string` content the key is the raw string. For `ContentPart[]` content (multi-modal messages) the key is `JSON.stringify(msg.content)`. The full key is `${role}:${contentKey}`. This means a `user` message and an `assistant` message with identical text are considered distinct — role is part of the identity. JSON.stringify is deterministic for a given object structure; however, object property order in `ContentPart` must be consistent for the same logical message to produce the same key. This is an implicit assumption: if two `ContentPart[]` arrays represent the same logical message but their properties were assigned in different orders, they will get different keys and both will pass through. In practice this is not a problem because `ContentPart` objects are constructed by the adapter from a canonical wire format.

**O(n) total.** One forward pass over `messages`. Each message does at most one `Set.has` and one `Set.add` — both O(1) amortized. Total: O(n) time, O(n) space for `seen` and `result`. First occurrence of a duplicate wins; subsequent occurrences are silently discarded. This preserves the earliest instance of a repeated message, which is semantically correct for conversation replay (the first time a tool returned the same result is the canonical occurrence).

## truncateToolResults

```ts
export function truncateToolResults(opts: TruncateOpts): Transform {
  if (opts.maxChars <= 50) {
    throw new TypeError(`truncateToolResults: maxChars must be > 50 (got ${opts.maxChars})`);
  }
  ...
}
```

**`maxChars > 50` guard.** The check throws at construction time, not at transform execution time. A `maxChars` of 10 would produce a marker string (e.g. `…[truncated, 9990 chars dropped]`) that is itself longer than `maxChars`, making `sliceLen` go negative and `slice(0, negative)` return an empty string — the tool result would be entirely replaced by a truncated marker. The guard at 50 is conservative: it ensures the marker and at least a few characters of actual content can coexist. Throwing at construction rather than returning an error transform catches misconfiguration before any messages are processed.

**Slice + marker construction.**

```ts
const dropped = msg.content.length - maxChars;
const marker = `…[truncated, ${dropped} chars dropped]`;
const sliceLen = Math.max(0, maxChars - marker.length);
return { ...msg, content: msg.content.slice(0, sliceLen) + marker };
```

`sliceLen` is computed so that `content.slice(0, sliceLen) + marker` has total length as close to `maxChars` as possible without exceeding it. `Math.max(0, ...)` prevents a negative slice index if the marker itself is longer than `maxChars` — only possible if `maxChars` is very close to 50 and the marker's `dropped` number has many digits. The `dropped` count in the marker is an exact character count, not an approximation; the model can use this to understand how much context it's missing.

**Only `role === 'tool'` messages are affected.** The transform maps over all messages but returns non-tool messages untouched (`if (msg.role !== 'tool') return msg`). Tool results are the primary source of large context blobs — API responses, file contents, search results. User and assistant messages are assumed to be human-scale in size.

## windowLast / windowFirst

Both are thin wrappers around a shared `applyWindow` function with a `take: 'first' | 'last'` parameter.

### alwaysKeep option

```ts
const alwaysKeepRoles = opts.alwaysKeep ?? ['system'];
```

Default is `['system']`. Messages whose `role` is in `alwaysKeepRoles` are excluded from windowing and always included in the output. The rationale for defaulting to `['system']`: system messages are instructions that apply to the entire conversation. Dropping a system message removes the model's operating constraints — persona, capabilities, restrictions — unpredictably. No window size is small enough to justify that loss.

Callers can override `alwaysKeep` to `[]` (no always-keep roles) or add additional roles (e.g. `['system', 'tool']` to preserve all tool results). The option is a role list, not a predicate, so it cannot express message-specific conditions like "keep this specific system message but not that one."

### Index-preserving partition

```ts
const kept: Array<{ index: number; msg: Message }> = [];
const eligible: Array<{ index: number; msg: Message }> = [];
messages.forEach((msg, index) => {
  if (alwaysKeepRoles.includes(msg.role)) {
    kept.push({ index, msg });
  } else {
    eligible.push({ index, msg });
  }
});
```

Each message is tagged with its original array index before partitioning. The `eligible` array is then sliced (`take === 'last'` → `eligible.slice(-keep)`, `take === 'first'` → `eligible.slice(0, keep)`).

### Sort by original index after merge

```ts
const merged = [...kept, ...taken].sort((a, b) => a.index - b.index);
return merged.map((x) => x.msg);
```

After combining always-keep messages and windowed messages, the merged list is sorted by original index. Without this sort, the output would be all system messages first (from `kept`) followed by the windowed non-system messages — a reordering that changes the conversation's narrative structure. Sorting restores the original interleaving: if a system message appeared between two user turns, it remains between those two user turns in the output.

`windowFirst` uses the same `applyWindow` with `take: 'first'` and is the mirror image: it takes the first `keep` eligible messages instead of the last. Useful when the earliest turns are more semantically significant (e.g. the original user intent), and recent turns are exploratory or error-recovery noise.

## summarize

`summarize` is the only transform that makes a network call. It is also the only transform that accepts a `ProviderAdapter` at construction time.

### SummarizeOpts

```ts
export type SummarizeOpts = {
  when: (messages: Message[]) => boolean;
  adapter: ProviderAdapter;
  model: string;
  keepLast?: number;
  promptPrefix?: string;
};
```

**`when` predicate.** The caller supplies a function `(messages: Message[]) => boolean`. `summarize` runs the predicate against the current message array on every pipeline execution; if it returns `false`, the transform returns messages unchanged immediately. Typical predicates check message count or estimated token length — e.g. `(msgs) => msgs.length > 30`. The predicate is the caller's throttle; without it, every pipeline run would fire an LLM call regardless of context size, which is wasteful when the context is small.

### Minimum length guard

```ts
if (messages.length < keepLast + 2) return messages;
```

`keepLast` defaults to `4`. The guard ensures at least `keepLast + 2` messages exist before proceeding: `keepLast` messages to keep, at least 1 message to summarize (`toSummarize` slice), and 1 margin message (the `+2` covers the requirement that `toSummarize` is non-empty with some buffer). If the guard were `keepLast + 1`, it would be possible to call summarize with a single message to summarize and `keepLast` messages to keep, which is technically valid but produces a nearly useless summary. The guard exits early returning the unchanged messages — summarize is always fail-open.

### Summarization mechanics

```ts
const toSummarize = messages.slice(0, messages.length - keepLast);
const toKeep = messages.slice(messages.length - keepLast);
```

The array is split at `messages.length - keepLast`. Everything before that index is summarized; the last `keepLast` messages are preserved verbatim. The `toSummarize` slice is serialized as `JSON.stringify(toSummarize, null, 2)` and sent to the adapter as a `user` message, with `promptPrefix` as the `system` message. The 2-space JSON formatting is intentional — it makes the structure legible to the model without being as compact as minified JSON.

### Fail-open on adapter error

```ts
try {
  const resp = await opts.adapter.call({ ... });
  summary = resp.message.content;
} catch {
  return messages;
}
```

If the summarizer LLM call throws for any reason — network error, rate limit, adapter error, malformed response — the catch block returns the original `messages` array unchanged. The pipeline continues with unsummarized messages. This is explicit policy: compression is best-effort. An LLM call failing during a compression step should not abort the agent's main task. The agent continues with a larger context rather than no context at all. Losing some compression is always preferable to crashing the agent mid-task.

### Summary injection

```ts
return [{ role: 'system', content: `Summary of prior conversation: ${summary}` }, ...toKeep];
```

The summary is injected as a `system` message prepended to `toKeep`. Using `role: 'system'` signals to the model that this is contextual background, not part of the user-assistant exchange. The prefix string `"Summary of prior conversation: "` is literal in the output — it disambiguates the injected summary from any user-authored system instructions that may also be in `toKeep`.

## orderForCache

```ts
export function orderForCache(): Transform {
  return async (messages) => {
    const systems: Message[] = [];
    const rest: Message[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') systems.push(msg);
      else rest.push(msg);
    }
    return [...systems, ...rest];
  };
}
```

`orderForCache` reorders the message array so all system messages precede all non-system messages. It does not otherwise modify messages.

**Why this helps Anthropic's prompt cache.** The Anthropic adapter injects `cache_control: { type: 'ephemeral' }` on the last system block in the request. Anthropic's cache mechanism works by identifying a stable prefix of the token stream that is shared across multiple requests. System messages (instructions, persona, tool definitions) are semantically stable across turns — they don't change between the first user message and the tenth. By moving all system messages to the front, `orderForCache` maximizes the stable prefix: cache hits occur when the token prefix up to the cache breakpoint is identical between two requests. If system messages were interleaved with user and assistant turns, the stable prefix would end at the first non-system message (which changes every turn), and the cache would never hit past that point.

Placing system messages at the front concentrates all the stable content at the head of the token stream. The Anthropic adapter then marks the last system block, maximizing the length of the cached prefix and improving cache hit rate for long-running agents where system content is constant but conversation content grows.

`orderForCache` preserves the relative order within the system group and within the non-system group. It does not sort messages by any other criterion. The transform is a no-op for message arrays that are already in the correct order.
