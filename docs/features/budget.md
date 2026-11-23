# Budget

Enforce hard limits on agent spend — steps, tokens, and dollars.

A `Budget` tracks usage across one or more `call()`, `stream()` or `agent()` calls. Flint checks it **before** every request (pre-flight) and charges it **after** every response, so a run stops at the limit instead of discovering the overspend afterwards.

## Creating a budget

```ts
import { budget } from 'flint/budget';

const b = budget({
  maxSteps: 10,       // max number of LLM calls
  maxTokens: 50_000,  // max total tokens (input + output + cache reads + cache writes)
  maxDollars: 0.50,   // max spend in USD
});
```

At least one limit must be set; each one is optional on its own.

```ts
budget({}); // TypeError: budget: at least one of maxSteps, maxTokens, or maxDollars must be set
```

## Types

```ts
type BudgetLimits = { maxSteps?: number; maxTokens?: number; maxDollars?: number };

type BudgetRemaining = { steps?: number; tokens?: number; dollars?: number };
type BudgetSpent = { steps: number; tokens: number; dollars: number };

/** `steps` defaults to 1; pass 0 for spend that should not count as an agent step. */
type ConsumeInput = Partial<Usage> & { cost?: number; steps?: number };

type Reservation = { release(): void };

type Budget = {
  readonly limits: BudgetLimits;
  consume(x: ConsumeInput): void;
  assertNotExhausted(): void;
  /** Remaining after spend and outstanding reservations. */
  remaining(): BudgetRemaining;
  spent?(): BudgetSpent;
  reserve?(x: { tokens?: number; dollars?: number }): Reservation;
  /** A sub-budget: spend counts against both, and the child is exhausted when either is. */
  child?(limits: BudgetLimits): Budget;
};
```

`spent`, `reserve` and `child` are optional on the `Budget` type so you can supply your own implementation; the object returned by `budget()` always has all three.

You rarely call `consume()`, `reserve()` or `assertNotExhausted()` yourself — `call()`, `stream()` and `agent()` do it. Use `remaining()` and `spent()` to inspect headroom.

## What a call does with the budget

For every request, `call()` (and `stream()`, and each step of `agent()`) runs this sequence:

1. **`assertNotExhausted()`** — fails immediately if any limit is already reached (`used >= limit`).
2. **Estimate the prompt.** Flint counts the messages (`adapter.count()` when available, otherwise a character heuristic) plus the tool definitions.
3. **Clamp `max_tokens`.** The requested output cap is `maxTokens` from the call, or the adapter's `capabilities.defaultMaxTokens`. Flint lowers it to whatever the budget can still pay for:
   - with `maxTokens`: `remaining.tokens - promptEstimate`
   - with `maxDollars` and a priced model: the output tokens affordable after paying for the whole prompt at the uncached input rate
4. **Refuse if nothing fits.** If the prompt alone uses up the remaining tokens or dollars, the call returns `BudgetExhausted` (`budget.tokens` / `budget.dollars`) **without calling the provider**.
5. **Reserve.** Flint places a hold of `prompt + max_tokens` tokens (and the worst-case dollar cost) on the budget, so concurrent calls sharing one budget cannot jointly overspend.
6. **Settle.** When the response arrives the hold is released and the actual usage and cost are charged with `consume()`.

The result: a single call can overshoot `maxTokens` / `maxDollars` by at most the error in the prompt estimate, not by a full response.

```ts
const b = budget({ maxTokens: 2_000 });

// The adapter would normally send max_tokens: 16000. Pre-flight lowers it
// so prompt + output stays inside the 2,000 remaining tokens.
const res = await call({ adapter, model: 'claude-opus-5-5', messages, budget: b });
```

### Self-calibrating prompt estimate

Local token counts miss provider-side framing (tool schemas, role markers, image tokens). After every `call()`, Flint compares the prompt it estimated with the prompt the provider actually billed (`input + cached + cacheWrite`) and keeps a correction ratio **per adapter instance and model**. Later pre-flights scale the estimate by that ratio (never below 1×). The ratio rises immediately when Flint under-estimated and relaxes slowly, because overspending is worse than a slightly small cap.

Calibration is in-process and learned from `call()` / `agent()` responses; nothing needs configuring.

## Pricing and dollar limits

Dollar accounting needs a price. After each response Flint takes the cost from:

1. `response.cost`, if the adapter reported one, otherwise
2. `costOf(usage, adapter.pricing(model))`, if the adapter can price the model.

The Anthropic adapter ships a price table ([details](/adapters/anthropic#pricing)); the OpenAI-compatible adapter accepts one via its `pricing` option. Pricing is also what enables the dollar clamp in pre-flight.

### Fail-closed when nothing can price the call

If the budget has `maxDollars` but neither source produced a cost, `call()` returns a `FlintError` with code **`budget.unpriced`** rather than silently treating the call as free:

```ts
const res = await call({
  adapter: unpricedAdapter,
  model: 'my-model',
  messages,
  budget: budget({ maxDollars: 1 }),
});
// res.ok === false, res.error.code === 'budget.unpriced'
```

The check runs when the response is settled, so the first unpriced request has already been sent (and its tokens and steps charged) when the error comes back. Fix it by giving the adapter pricing, or drop `maxDollars` and limit tokens instead.

### Pricing helpers

```ts
import { costOf, lookupPricing, worstCaseCost, affordableOutputTokens } from 'flint/pricing';
import type { ModelPricing, PriceTable } from 'flint/pricing';
```

```ts
/** US dollars per million tokens. cacheRead / cacheWrite default to 0.1x / 1.25x of input. */
type ModelPricing = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Above `threshold` prompt tokens (uncached + cached + cache-write) the whole request uses these rates. */
  longContext?: { threshold: number; input: number; output: number };
};
type PriceTable = Record<string, ModelPricing>;
```

| Function | Description |
|---|---|
| `costOf(usage, pricing)` | Dollar cost of a `Usage`. Uncached input, cache reads, cache writes and output are billed at their own rates. |
| `lookupPricing(table, model)` | Exact key match first, then the longest key contained in the model id (handles dated or region-prefixed ids). |
| `worstCaseCost(promptTokens, maxOutput, pricing)` | Cost if the whole prompt is uncached and the full output budget is used. |
| `affordableOutputTokens(dollars, promptTokens, pricing)` | Output tokens left after paying for `promptTokens` of uncached input. |

All four are also exported from `flint`.

## Reservations

`reserve()` is what makes one budget safe to share between parallel calls. Each in-flight request holds its worst case; `remaining()` subtracts outstanding holds; `release()` is idempotent.

```ts
const b = budget({ maxTokens: 100 });
const hold = b.reserve!({ tokens: 60 });
b.remaining().tokens; // 40
hold.release();
b.remaining().tokens; // 100
```

Steps are never reserved — only tokens and dollars.

## Child budgets

`child()` creates a sub-budget. Everything the child spends is also charged to the parent, and the child's `remaining()` is the tighter of its own limits and the parent's. Use it to give one sub-task (a tenant, a tool that calls a model, a summarizer) its own cap inside a session cap.

```ts
const session = budget({ maxDollars: 5 });
const research = session.child!({ maxDollars: 1, maxSteps: 20 });

await agent({ adapter, model: 'claude-opus-5-5', messages, tools, budget: research });

session.spent!().dollars;   // includes the research agent's spend
research.remaining();       // never more than the session has left
```

A child is exhausted when either it or its parent is. Reservations taken on the child are mirrored on the parent.

## Steps

Each successful call charges one step by default. Pass `budgetSteps: 0` to `call()` for auxiliary requests that should cost tokens and dollars but not count as an agent step — the [context manager](/features/context) does this for its summarizer calls. Direct `consume()` calls accept `steps` the same way.

## Checking remaining budget

```ts
const b = budget({ maxSteps: 5, maxDollars: 0.10 });

await agent({ ..., budget: b });

const rem = b.remaining();
console.log(`Steps left: ${rem.steps}`);
console.log(`Dollars left: $${rem.dollars?.toFixed(4)}`);
console.log('Spent so far:', b.spent!()); // { steps, tokens, dollars }
```

## BudgetExhausted

When a limit is hit, `call()` or `agent()` returns `{ ok: false, error: BudgetExhausted }`.

```ts
import { BudgetExhausted } from 'flint/errors';

const res = await agent({ ..., budget: b });

if (!res.ok && res.error instanceof BudgetExhausted) {
  console.log('Hit budget limit:', res.error.code, res.error.message);
}
```

`BudgetExhausted.code` is one of `'budget.steps'`, `'budget.tokens'`, `'budget.dollars'`. It is returned in three situations:

| When | Provider called? |
|---|---|
| The budget was already exhausted before the call | No |
| Pre-flight: the prompt alone leaves no room for output | No |
| Settle: actual usage pushed spend past the limit (estimate error) | Yes — the response is discarded |

## Reusing a budget across calls

A budget is stateful. Pass the same instance to several calls to enforce a cumulative cap:

```ts
const sessionBudget = budget({ maxDollars: 1.00 });

const r1 = await agent({ ..., budget: sessionBudget });
const r2 = await agent({ ..., budget: sessionBudget }); // continues depleting the same pool

console.log('Remaining:', sessionBudget.remaining());
```

## Common mistakes

::: warning budget is required for agent()
`agent()` requires a `budget` argument. There's no default — this is intentional. Agents without budget limits can run indefinitely.
:::

::: warning maxDollars needs pricing
`maxDollars` only works when the adapter reports `cost` or implements `pricing(model)`. Otherwise calls fail with `budget.unpriced`. See [Writing an Adapter](/adapters/custom#pricing).
:::

## See also

- [agent()](/primitives/agent) — uses budget for loop control
- [call()](/primitives/call) — pre-flight, retries and `budgetSteps`
- [Context management](/features/context) — compaction economics use the same pricing
- [Error Types](/reference/errors) — BudgetExhausted, `budget.unpriced`
