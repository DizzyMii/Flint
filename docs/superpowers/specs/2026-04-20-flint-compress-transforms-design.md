# Flint Compress Transforms — Design

**Date:** 2026-04-20
**Plan:** 5 of 11
**Scope:** Implement 6 compress transforms (`dedup`, `truncateToolResults`, `windowLast`, `windowFirst`, `summarize`, `orderForCache`). Remove `pinSystem` from the public surface (replaced by `alwaysKeep` option on the window transforms).
**Status:** Approved, pending user review

## Goal

Deliver the compress transforms promised by the Flint positioning pitch ("compress module cuts token usage 40-80% via composable transforms"). After Plan 5, users can build pipelines like:

```typescript
import { pipeline, dedup, windowLast, truncateToolResults, summarize } from 'flint/compress';

const compress = pipeline(
  dedup(),
  truncateToolResults({ maxChars: 2000 }),
  windowLast({ keep: 20 }),
  summarize({
    when: (msgs) => count(msgs, model) > 8000,
    adapter,
    model: 'haiku',
  }),
);
```

Plus `orderForCache()` for Anthropic-style prompt-cache prefix stability.

## Files touched

```
packages/flint/
├── src/
│   └── compress.ts                     # MODIFY: replace 6 stubs with real impl; remove pinSystem
└── test/
    ├── compress.test.ts                # REPLACE: full coverage (per-transform + integration)
    └── surface.test.ts                 # MODIFY: remove 'pinSystem' from expected exports
```

**Breaking-change note:** `pinSystem` is removed from the public surface. It was never functional (stub-only since Plan 1) and is replaced by the `alwaysKeep: ['system']` option on `windowLast` / `windowFirst`. No user code can be relying on it because it only threw `NotImplementedError`.

## Transform contracts

Every transform has the signature:

```typescript
type Transform = (messages: Message[], ctx: CompressCtx) => Promise<Message[]>;
```

All transforms are **pure** — they return a new array, never mutate input. Transforms don't reach into `ctx` unless documented (only `summarize` does).

### `dedup()`

**Purpose:** Remove duplicate messages to shrink repeated context.

**Semantics:**
- Two messages are duplicates iff `role + content` match exactly
- For `role: 'system'`, duplicates are always kept (system messages carry instructions, dropping them changes behavior)
- For `ContentPart[]` content, compare via `JSON.stringify` (deep equality via stable serialization)
- For messages with `toolCalls` (assistant role) or `toolCallId` (tool role), those fields are *not* part of the duplicate key — content alone matters
- **Keep first occurrence** in chronological order; drop subsequent duplicates

**Rationale:** Agent loops often re-inject the same user instruction. Dedup of tool results with identical content (e.g., "No matches found.") compounds savings.

### `truncateToolResults({ maxChars })`

**Purpose:** Cap tool result message size so large outputs (file dumps, search hits) don't blow context.

**Semantics:**
- Only affects messages with `role: 'tool'`
- If `content.length <= maxChars`: unchanged
- If `content.length > maxChars`: replace with `content.slice(0, maxChars - markerLen) + marker`
- Marker: `…[truncated, N chars dropped]` where N is the number of dropped characters
- Preserves `toolCallId`
- `maxChars` must be > 50 (reasonable room for the marker); enforced via `TypeError` on construction

### `windowLast({ keep, alwaysKeep? })`

**Purpose:** Keep only the most recent N messages plus any messages whose role is in `alwaysKeep`.

**Semantics:**
- `keep` must be `>= 0`; `TypeError` otherwise
- `alwaysKeep`: `Role[]`, defaults to `['system']`
- Algorithm:
  1. Partition messages into `kept` (role in `alwaysKeep`) and `eligible` (rest), preserving original index
  2. Take last `keep` of `eligible`
  3. Merge `kept` + taken-last back in original order via index
- Edge case: `keep: 0, alwaysKeep: []` → returns `[]`
- Edge case: `keep: 0, alwaysKeep: ['system']` → returns only system messages in their original positions

### `windowFirst({ keep, alwaysKeep? })`

**Purpose:** Mirror of `windowLast` — keep first N + alwaysKeep roles.

**Semantics:** Same as `windowLast` but takes first `keep` of eligible, not last.

### `summarize({ when, adapter, model, keepLast? })`

**Purpose:** When history grows large, compress old messages into a summary and preserve only recent ones verbatim.

**Types:**

```typescript
type SummarizeOptions = {
  when: (messages: Message[]) => boolean;
  adapter: ProviderAdapter;
  model: string;
  keepLast?: number;          // default 4
  promptPrefix?: string;      // default: "Summarize the following conversation concisely, preserving key facts, decisions, and user intent:"
};
```

**Semantics:**
1. If `when(messages)` returns false → return messages unchanged
2. If `messages.length < keepLast + 2` (nothing to summarize) → return unchanged
3. Split: `toSummarize = messages.slice(0, -keepLast)`, `toKeep = messages.slice(-keepLast)`
4. Build summarization prompt:
   - `system`: `promptPrefix` (default above)
   - `user`: JSON.stringified `toSummarize` (or pretty-printed text form)
5. Call `adapter.call({ model, messages: [systemMsg, userMsg] })`
6. On success: return `[{ role: 'system', content: 'Summary of prior conversation: ' + response.content }, ...toKeep]`
7. On error: log via optional logger (future); for now, return messages unchanged (fail-open). Rationale: compression is best-effort; never break the agent because summarization failed.

**Tradeoff note:** This requires an LLM call per summarize trigger. Users should pair with a cheap model (`haiku`, `gpt-4o-mini`). The `when` predicate ensures we only pay the cost past a threshold.

### `orderForCache()`

**Purpose:** Reorder messages so the stable prefix (system) comes first, maximizing Anthropic prompt-cache hit rates.

**Semantics:**
- Move all `role: 'system'` messages to the front, preserving their relative order
- All other messages retain their chronological order relative to each other
- No cache_control markers inserted (adapter-level concern in Plan 9)

**Example:**
```
input:  [user, asst, system, user, asst, system]
output: [system, system, user, asst, user, asst]
```

## Tests

Fresh `packages/flint/test/compress.test.ts` replaces the existing stub-era tests. Organized by transform.

### `dedup`

- Empty array → empty
- No duplicates → unchanged
- Identical user messages → second dropped; first preserved
- Identical system messages → both kept (system exempt)
- Different content same role → both kept
- ContentPart[] compared via JSON.stringify → identical parts considered duplicate
- Assistant toolCalls do not participate in dedup key → two assistant messages with same content but different toolCalls: second dropped
- Order preserved for survivors

### `truncateToolResults`

- `maxChars: 50` → TypeError (too small)
- Short tool result → unchanged
- Long tool result → truncated + marker, length <= maxChars
- Marker includes correct dropped count
- Non-tool messages untouched regardless of length
- Preserves `toolCallId`

### `windowLast`

- `keep: -1` → TypeError
- `keep: 0, alwaysKeep: []` → empty array
- `keep: 3` on 5 non-system messages → last 3
- `keep: 2, alwaysKeep: ['system']` on `[sys, u1, a1, u2, a2, u3]` → `[sys, a2, u3]`
- Multiple system messages preserved in original positions
- `alwaysKeep` empty explicitly strips system too
- No mutation of input array

### `windowFirst`

- Mirror of windowLast: takes first N
- `keep: 3` on 5 non-system → first 3
- `keep: 2, alwaysKeep: ['system']` on same fixture → `[sys, u1, a1]`
- Edge cases parallel to windowLast

### `summarize`

- `when` returns false → unchanged
- Fewer than `keepLast + 2` messages → unchanged (nothing to summarize)
- Trigger fires → adapter.call invoked once with summarization prompt
- Result: last `keepLast` messages preserved; replaced prefix becomes one system message prefixed with "Summary of prior conversation: "
- Adapter throws → return messages unchanged (fail-open)
- `promptPrefix` override honored in system message

### `orderForCache`

- No system messages → unchanged
- One system at position 2 → moved to position 0
- Multiple systems preserved in relative order
- Non-system chronological order preserved
- No mutation

### `pipeline` integration

Replaces 2-3 tests from Plan 4's pipeline file with composition scenarios:

- `pipeline(dedup, truncateToolResults)` runs both in order
- `pipeline(windowLast({ keep: 5 }), dedup)` windows first then dedups
- Real scenario: 30-message conversation → window + truncate → verify total char count < target

### Surface test update

Remove `pinSystem` from the expected exports list in `test/surface.test.ts`. Expected symbols: `pipeline, dedup, truncateToolResults, windowLast, windowFirst, summarize, orderForCache` (7 total, down from 8).

## Out of scope for Plan 5

- Cache_control markers on individual messages (adapter-level, Plan 9)
- Token-aware compression (transforms currently operate on char counts; token-aware requires `count()` dispatch and is future optimization)
- Streaming compress
- Semantic dedup (near-duplicates via embedding similarity)
- Rolling summaries (multi-stage: summary → summary of summary)

## Success criteria

1. All 6 transforms implemented (7 functions counting `pipeline` from Plan 4)
2. `pinSystem` removed from public API surface
3. `compress.ts` has zero `NotImplementedError` throws (all stubs replaced)
4. ~40 new/updated tests pass
5. Typecheck zero errors
6. Existing 166 flint tests still pass (minus the ~8 tests that were testing stubs, rewritten as real)
7. Zero new runtime deps
8. `pipeline(dedup(), windowLast({ keep: 5 }))` on a test corpus reduces character count by ≥ 50%
9. Tag `v0.4.0`
