---
"flint": minor
"@flint/adapter-anthropic": minor
"@flint/adapter-openai-compat": minor
"@flint/graph": minor
"landlord": minor
---

Make Flint's cost, caching and correctness claims hold at runtime.

**Fixes**
- `maxDollars` was a no-op with the first-party adapters (no adapter reported `cost`). Adapters now expose `pricing(model)`; `call()` computes cost centrally and fails closed with `budget.unpriced` when a dollar limit cannot be priced.
- Budgets are enforced before a call, not only after: `max_tokens` is clamped to what the remaining tokens/dollars can buy, and a call whose prompt alone exceeds the budget is refused without being sent.
- Anthropic cache-write tokens were dropped from usage and cost.
- Malformed streamed tool arguments ran the tool with `{}`; they now reach the model as an is-error result.
- `windowLast`/`windowFirst`/`dedup`/`summarize` could orphan tool results (provider 400s); transforms are now turn-atomic and `call()` rejects any transform that breaks the transcript (`compress.malformed`).
- Tool timeouts did not stop the tool; handlers now receive an abort signal.
- Graph fan-out re-ran the first branch and dropped sibling continuations; node errors escaped `Result`; checkpointing was never wired.
- `agent()` discarded all steps on failure; `partialRun(error)` now returns them. `Step.messagesSent` is the snapshot actually sent.
- `flint` subpath bundles duplicated classes, so `instanceof` on errors failed across imports; builds now share chunks.

**New**
- Pricing module (`flint/pricing`) and built-in Anthropic price table.
- Classified `AdapterError` (`kind`, `retryable`, `retryAfterMs`) and automatic retries with retry-after support.
- Event-log agent core: `agentStream()`, `onEvent`, `eventLog()`, `transcriptFrom()` for crash resume, `usageFrom()`.
- Cost-aware, prefix-stable `contextManager()` (`flint/context`) with forced compaction on context overflow.
- Rolling 4-breakpoint prompt-cache layout for Anthropic (simulated 30-step run: $2.56 → $0.45).
- Lossless thinking-block round-trip, `isError` tool results, `refusal` stop reason, native structured output via `jsonSchema`, provider `extra` body fields.
- `recordingAdapter` / `replayAdapter` cassettes in `flint/testing`.
- Budget reservations, child budgets, `spent()`.

**Behaviour changes to review when upgrading**
- Anthropic: prompt caching now defaults to `'auto'` (pass `cache: 'off'` to opt out); default `max_tokens` is 16000 (was 4096); the deprecated `prompt-caching-2024-07-31` beta header is no longer sent.
- `Usage.input` means uncached input tokens. The OpenAI-compatible adapter previously reported `prompt_tokens` (which includes cached tokens) as `input`.
- `StopReason` gains `'refusal'`; exhaustive switches need a branch.
- `dedup()` no longer removes duplicate tool-calling assistant turns.
- With `maxDollars` set, calls through an adapter that cannot price the model now fail with `budget.unpriced` instead of silently not enforcing the limit.
- Graph fan-out merges only the keys each branch changed and continues at the branches' shared join node; diverging joins fail with `graph.ambiguous_join`.
- Landlord file tools reject symlink escapes; bash commands time out after 120s.
