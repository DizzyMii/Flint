# 07 — Budget

**Source:** `packages/flint/src/budget.ts`
**See also:** Doc 02 (BudgetExhausted error), Doc 06 (primitives — where consume is called), Doc 14 (graph — node-level consume)

## BudgetLimits type

`BudgetLimits` is a plain object type with three optional fields: `maxSteps?: number`, `maxTokens?: number`, `maxDollars?: number`. The TypeScript type itself does not enforce that at least one is present — all three are optional at the type level. The enforcement is a runtime guard at the top of the `budget()` factory: if all three are `undefined`, a `TypeError` is thrown immediately. This is a programmer-error condition (like passing no messages to `call`), so it throws unconditionally rather than returning a `Result`.

"Steps" means one per `consume` call, which maps to one adapter invocation — one full LLM turn, regardless of how many tokens were generated. A step does not track streaming chunks or internal loops; it counts discrete calls to `adapter.call` or `adapter.stream`. This makes steps a useful coarse budget for agentic loops where you want to cap the number of model round-trips independently of token volume.

## Closure state

`budget()` initializes three mutable counters inside the function scope:

```ts
let stepsUsed = 0;
let tokensUsed = 0;
let dollarsUsed = 0;
```

These are closed over by the returned object's methods. The design uses a closure rather than a class for two reasons. First, closures are lighter — no prototype chain allocation, no `this` binding, and the returned object literal is the complete public surface. Second, there is no risk of `this` escaping: methods on the returned object capture variables directly from the enclosing scope rather than accessing state through `this`, so destructuring `const { consume, assertNotExhausted, remaining } = budget(limits)` works correctly without `.bind()`. This also means the `Budget` interface type is structural — any object that satisfies the shape is a valid budget — which is important for test doubles and the graph's duck-typed `isBudgetExhausted` check.

## consume(usage, cost?)

The public `consume` method takes a `ConsumeInput`, which is `Partial<Usage> & { cost?: number }`. All three usage fields and `cost` are optional at the call site — the `graph` engine passes `{ input: 0, output: 0 }` with no token spend because it only needs step tracking.

Accumulation:

```ts
stepsUsed += 1;
tokensUsed += (x.input ?? 0) + (x.output ?? 0) + (x.cached ?? 0);
dollarsUsed += x.cost ?? 0;
```

Steps always increment by 1 regardless of token count — one `consume` call is one LLM turn. Token accumulation includes `cached` tokens (the `Usage.cached?: number` field from Doc 01). Anthropic reports prompt-cache hit tokens separately from uncached input tokens; both consume context capacity and should be counted against a token budget. Omitting `cached` would undercount token spend for cache-heavy workloads.

After incrementing, `checkExhaustedAfterConsume()` is called and uses `>` (strictly greater than):

```ts
if (limits.maxSteps !== undefined && stepsUsed > limits.maxSteps) { ... }
```

If the check fires, a `BudgetExhausted` is thrown with the appropriate `budget.steps`, `budget.tokens`, or `budget.dollars` code. The message format is `"Budget exhausted: ${field} used ${used} >= limit ${limit}"` — the wording says `>=` but the check is `>`; for the post-consume path the message is an approximation, describing the semantic condition (the limit has been reached or exceeded) rather than the precise comparison operator used.

## assertNotExhausted()

The pre-call guard uses `checkExhaustedBefore()`, which applies `>=` (greater than or equal):

```ts
if (limits.maxSteps !== undefined && stepsUsed >= limits.maxSteps) { ... }
```

Called in `call` and `stream` before the adapter invocation. In `call`, the thrown `BudgetExhausted` is caught and returned as `{ ok: false, error }`. In `stream`, it is thrown directly and propagates from the async generator — the `stream` primitive does not wrap budget failures in `Result` because there is no clean place to intercept before the generator yields anything.

The message format is `"Budget already exhausted: ${field} used ${used} >= limit ${limit}"`. Because `assertNotExhausted()` uses `>=`, the `>=` wording in the message is exact — unlike the post-consume path in `consume()`, where the check uses `>` but the message still says `>=` (an approximation).

### The >= / > asymmetry

The two checks use different operators deliberately, and the difference determines what "limit means N" means in practice.

Scenario: `maxSteps: 3`, starting from `stepsUsed = 0`.

- Call 1: `assertNotExhausted` checks `0 >= 3` → false, passes. Adapter runs. `consume` increments to 1, checks `1 > 3` → false. OK.
- Call 2: `assertNotExhausted` checks `1 >= 3` → false, passes. Adapter runs. `consume` increments to 2, checks `2 > 3` → false. OK.
- Call 3: `assertNotExhausted` checks `2 >= 3` → false, passes. Adapter runs. `consume` increments to 3, checks `3 > 3` → false. OK.
- Call 4: `assertNotExhausted` checks `3 >= 3` → true. **Fires. No adapter call.**

The limit `maxSteps: 3` allows exactly 3 adapter calls. After the third call, `stepsUsed` equals 3, and `assertNotExhausted` blocks the fourth attempt. At no point does the post-consume check (`>`) fire when `used === limit` — only when `used > limit`, which would only happen if somehow consume were called after the budget was already at the limit. The pre-call `>=` check prevents that from happening in the primitives layer.

This means the limit is inclusive: "allow up to N calls" rather than "stop before the Nth call." The asymmetry is the mechanism that makes this work. If both checks used `>=`, the Nth call itself would be blocked. If both used `>`, a Nth+1 call would complete before the post-consume check fired.

## remaining()

Returns a `BudgetRemaining` object (`{ steps?: number; tokens?: number; dollars?: number }`) containing only the fields for which limits were defined. Undefined-limit fields are omitted entirely via the spread pattern:

```ts
...(limits.maxSteps !== undefined ? { steps: Math.max(0, limits.maxSteps - stepsUsed) } : {})
```

Each value is floored at zero with `Math.max(0, ...)`. The floor exists because callers use `remaining()` to decide whether compression is needed — for example, a compress transform might check `budget.remaining().tokens` to decide how aggressively to truncate the conversation history. A negative remaining would signal "you're over budget" but would be semantically ambiguous in this context and could cause a compression step to underestimate how much space to free. Flooring at zero means the answer is always "zero or more tokens left", which is unambiguous for capacity planning.

`remaining()` is a snapshot, not a live view. The returned object is constructed fresh on each call from the current counter values.

## ExhaustedField internal type

```ts
type ExhaustedField = {
  field: 'steps' | 'tokens' | 'dollars';
  limit: number;
  used: number;
};
```

This internal type is the return value of both check functions and is used only to construct the `BudgetExhausted` error. `field` is a string union (not the broader `string`) because it is interpolated directly into the error code (`budget.${exhausted.field}`) and into the human-readable message. Using a union type ensures exhaustiveness — the three values correspond exactly to the three limits. `limit` and `used` go into the message string as diagnostic context; callers who catch `BudgetExhausted` can re-read these values from the error message but there is no structured `meta` object on `BudgetExhausted` itself (beyond `code`), so they are expressed in the human-readable string only.

## Where budget is consumed

**`call` primitive** (`packages/flint/src/primitives/call.ts`): `assertNotExhausted()` is called after optional compression and before `adapter.call`. On success, `budget.consume({ ...resp.usage, cost: resp.cost })` is called with the full usage and cost from the adapter response. Both the pre-check failure and the post-consume failure are caught and returned as `{ ok: false, error }`.

**`stream` primitive** (`packages/flint/src/primitives/stream.ts`): `assertNotExhausted()` is called before entering the adapter stream loop. `budget.consume()` is called inside the `for await` loop when a `usage` chunk arrives:

```ts
if (chunk.type === 'usage' && options.budget) {
  options.budget.consume({ ...chunk.usage, cost: chunk.cost });
}
```

The `yield chunk` statement comes after the `consume` call in the source. If `consume` throws `BudgetExhausted`, the `yield` is never reached — the exception propagates immediately and the stream terminates. The caller's `for await` loop receives the exception rather than the usage chunk. The consume happens inside the loop because streaming usage is only reported in the final `usage` chunk, not distributed across text deltas.

**`graph` engine** (`packages/graph/src/index.ts`): The graph calls `budget.consume({ input: 0, output: 0 })` once per node execution, before the node function runs. In `runStream` specifically, consume is also called before the `enter` event is yielded to the caller — the step is counted before the caller's `for await` loop receives any notification that the node is starting. This increments `stepsUsed` by 1 with zero token or dollar impact — it is purely step tracking for graph traversal. The graph uses a duck-type check (`isBudgetExhausted`) rather than `instanceof` to avoid cross-bundle `instanceof` failures when the graph package and the flint package are bundled separately and produce distinct class references.

In `run`, the consume error is caught and returned as `{ ok: false, error }`. In `runStream`, the consume is bare — the thrown `BudgetExhausted` propagates directly from the async generator, terminating iteration. This is consistent with `stream` primitive behavior. The reason `runStream` cannot wrap the error in a `Result` is structural: async generators have no mechanism to return a value on error — they can only `throw` or `yield`. Since `runStream` is an async generator, any error from `consume` is propagated as a thrown exception from the iterator; there is no other option available.

The graph's step tracking stacks on top of any per-call budget consumption happening inside node functions. A node that calls `call(...)` with the same budget will trigger both the graph's pre-node consume (one step) and `call`'s post-response consume (another step plus tokens and dollars). The two counts are additive in the same budget instance.
