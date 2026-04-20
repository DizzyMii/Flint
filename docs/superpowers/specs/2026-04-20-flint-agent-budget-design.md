# Flint Agent Loop + Budget — Design

**Date:** 2026-04-20
**Plan:** 3 of 10
**Scope:** Real `budget()` and `agent()` implementations; wire budget exhaustion through `call` and `stream` error paths; tighten `CallOptions.schema` generic.
**Status:** Approved, pending user review

## Goal

Make `agent()` a usable loop primitive that drives a model through tool calls until completion, with real budget enforcement. After Plan 3, a user can run an agent end-to-end against `mockAdapter` with budget caps, tool error recovery, parallel tool execution, and step tracking. Real provider adapters (Plans 8, 9) are the last pieces before the runtime is usable in production.

## Positioning

`agent()` is the 80% agent primitive. Users who need branching workflows pick up `@flint/graph` in Plan 7. `agent()` is deliberately thin: one model, one goal, loops until the model says "done."

## Files touched

- **Modify (stub → real):**
  - `packages/flint/src/budget.ts`
  - `packages/flint/src/agent.ts`
  - `packages/flint/src/primitives/call.ts` (tighten schema generic + wrap budget throws)
- **Modify tests (expand from surface checks to full coverage):**
  - `packages/flint/test/budget.test.ts`
  - `packages/flint/test/agent.test.ts`
  - `packages/flint/test/call.test.ts` (add budget cases)
  - `packages/flint/test/stream.test.ts` (add budget case)

No file creation this plan. No subpath export changes. No new runtime deps.

## Budget

### Shape

```typescript
export type BudgetLimits = {
  maxSteps?: number;      // hard cap on LLM call count
  maxTokens?: number;     // input + output + cached
  maxDollars?: number;    // sum of adapter-reported cost
};

export type BudgetRemaining = {
  steps?: number;
  tokens?: number;
  dollars?: number;
};

export type ConsumeInput = {
  input?: number;
  output?: number;
  cached?: number;
  cost?: number;
};

export type Budget = {
  readonly limits: BudgetLimits;
  consume(x: ConsumeInput): void;
  assertNotExhausted(): void;
  remaining(): BudgetRemaining;
};
```

### Semantics

- **Construction:** `budget(limits)` — at least one of `maxSteps`, `maxTokens`, `maxDollars` must be set, otherwise `TypeError`. (Unused budget is always a bug.)
- **`consume(x)`:** adds tokens and cost, increments `steps` by 1 (one consume = one step). After the add, checks all active limits. If any exceeds, **throws `BudgetExhausted`**.
- **`assertNotExhausted()`:** checks current state against limits without consuming. Throws `BudgetExhausted` if any active limit is exceeded.
- **`remaining()`:** returns an object with numeric values for active limits and `undefined` for unset limits. Example: `budget({ maxSteps: 10, maxTokens: 1000 }).remaining()` → `{ steps: 10, tokens: 1000 }` (no `dollars` key).
- **Error codes:** `budget.steps`, `budget.tokens`, `budget.dollars`. First-active-field-exceeded wins.
- **Unlimited fields:** `undefined` means "no limit." Consumption still updates internal counters for `remaining()` accuracy, but no exhaustion check fires.

### Why throw, not Result?

Budget's callers (`call`, `agent`) wrap the throw into `Result.error(BudgetExhausted)` at their boundaries. `stream` lets it propagate (streaming already uses throws). Keeping budget itself throw-based means it's ergonomic for the internals that call it in tight loops.

## Agent loop

### Contract

```typescript
export async function agent(options: AgentOptions): Promise<Result<AgentOutput>>
```

Types `AgentOptions`, `Step`, `AgentOutput`, `ToolsParam` are already defined in `packages/flint/src/agent.ts` from Plan 1.

### Algorithm

```
agent(options) →
  const maxSteps = options.maxSteps ?? Infinity
  const messages: Message[] = [...options.messages]
  const steps: Step[] = []

  while (steps.length < maxSteps):
    // 1. Resolve tools (lazy support)
    const tools =
      options.tools === undefined
        ? []
        : typeof options.tools === 'function'
          ? await options.tools({ messages, step: steps.length })
          : options.tools

    // 2. Call model (call handles compress, budget, adapter error, validation)
    const result = await call({
      adapter: options.adapter,
      model: options.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      budget: options.budget,
      compress: options.compress,
      logger: options.logger,
      signal: options.signal,
    })
    if (!result.ok) return result  // BudgetExhausted, AdapterError, etc.

    const { message, usage, cost, stopReason } = result.value

    // 3. Append assistant reply to history
    messages.push(message)

    // 4. Terminal: no tool calls
    if (stopReason !== 'tool_call' || !message.toolCalls || message.toolCalls.length === 0):
      return Result.ok({
        message,
        steps,
        usage: aggregateUsage(steps, usage),
        cost: aggregateCost(steps, cost),
      })

    // 5. Execute tool calls in parallel
    const toolResults: Array<Message & { role: 'tool' }> = await Promise.all(
      message.toolCalls.map(tc => runToolCall(tc, tools))
    )

    // 6. Append tool results
    messages.push(...toolResults)

    // 7. Record step
    const step: Step = {
      messagesSent: [...messages],   // snapshot of what was sent this iteration
      assistant: message,
      toolCalls: message.toolCalls,
      toolResults,
      usage,
      cost,
    }
    steps.push(step)

    // 8. onStep callback (fire-and-forget — not awaited)
    options.onStep?.(step)

  // Max steps exceeded without terminal
  return Result.error(new FlintError('Agent exceeded max steps', {
    code: 'agent.max_steps_exceeded',
    cause: messages[messages.length - 1],
  }))

runToolCall(tc, tools) →
  const tool = tools.find(t => t.name === tc.name)
  if (!tool):
    return { role: 'tool', content: `Error: unknown tool "${tc.name}"`, toolCallId: tc.id }
  const execResult = await execute(tool, tc.arguments)
  if (execResult.ok):
    const body = typeof execResult.value === 'string'
      ? execResult.value
      : JSON.stringify(execResult.value)
    return { role: 'tool', content: body, toolCallId: tc.id }
  // Feed error back — don't bail the loop
  return {
    role: 'tool',
    content: `Error: ${execResult.error.message}`,
    toolCallId: tc.id,
  }
```

### Key behaviors

1. **Tool error recovery.** If a tool handler throws or validation fails, the error text is fed back as a tool message so the model can recover (try a different input, different tool, or apologize). Matches ReAct/LangGraph convention.
2. **Unknown tools** handled identically — tool message with error, loop continues.
3. **Tool result serialization.** Strings pass through; everything else is `JSON.stringify`-ed. Users who need custom serialization can wrap the handler.
4. **Parallel execution via `Promise.all`.** No concurrency cap in v0 (providers already cap how many tool calls they emit per response).
5. **`onStep` is not awaited.** Users can `await` inside if they need to block, but the agent moves on immediately. If `onStep` throws, the throw surfaces after the next `await` — documented caveat.
6. **Aggregated usage/cost** in `AgentOutput` sums across all steps plus the terminal call.
7. **`messagesSent`** in each `Step` is a snapshot *after* the tool results are appended, making it easy to replay or inspect.
8. **Budget check is in `call`,** not duplicated in `agent`. The budget's own `maxSteps` limit and `agent.maxSteps` option are redundant-but-independent — either can terminate the loop.

### When budget and agent.maxSteps disagree

Intentional: `budget.maxSteps` is a global cap (applies to any path that consumes from the budget, including non-agent uses like a recipe making one-off `call`s). `options.maxSteps` is agent-specific. Both can be set; the tighter one wins implicitly. Documentation spells this out.

## `CallOptions<T>` generic tightening

### Before (Plan 2)

```typescript
export type CallOptions = Omit<NormalizedRequest, 'signal' | 'messages'> & {
  adapter: ProviderAdapter;
  messages: Message[];
  budget?: Budget;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
};

export async function call<T = unknown>(options: CallOptions): Promise<Result<CallOutput<T>>>
```

Problem: `options.schema` comes via the `NormalizedRequest` intersection and is `StandardSchemaV1 | undefined` (unrelated to `T`). Users write `call<MyShape>({ schema })` and TS silently accepts a wrong-typed schema; cast to `T` happens at runtime.

### After

```typescript
export type CallOptions<T = unknown> = Omit<NormalizedRequest, 'signal' | 'messages' | 'schema'> & {
  adapter: ProviderAdapter;
  messages: Message[];
  schema?: StandardSchemaV1<unknown, T>;
  budget?: Budget;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
};

export async function call<T = unknown>(options: CallOptions<T>): Promise<Result<CallOutput<T>>>
```

Now `call<MyShape>({ schema })` requires `schema` to produce `MyShape`; otherwise compile error.

The runtime cast `output.value = validated.value as T` stays — at the type level `T` and schema output are unified, so the cast is provably safe; `as T` is a TypeScript-limitation workaround, not a type hole.

## Budget-throw wrapping in `call`

The Plan 2 `call` implementation already calls `options.budget?.assertNotExhausted()` and `options.budget?.consume(...)` but budget was a stub (all methods throw `NotImplementedError`). Tests didn't pass a budget, so the throws never fired.

In Plan 3, once the real budget can throw `BudgetExhausted`, `call` must catch and return `Result.error`. Wrap both budget call sites:

```typescript
if (options.budget) {
  try {
    options.budget.assertNotExhausted();
  } catch (e) {
    if (e instanceof BudgetExhausted) return { ok: false, error: e };
    throw e;
  }
}

// ... after adapter response:
if (options.budget) {
  try {
    options.budget.consume({
      ...resp.usage,
      ...(resp.cost !== undefined ? { cost: resp.cost } : {}),
    });
  } catch (e) {
    if (e instanceof BudgetExhausted) return { ok: false, error: e };
    throw e;
  }
}
```

`stream` is unchanged — its budget consume is inside the `for await` loop, and throws propagate out of the async iterable naturally. Documented: "If a `BudgetExhausted` is thrown mid-stream, iterate in a `try/catch`."

## Tests

### `budget.test.ts` — replace all stub tests

- `budget({})` → throws `TypeError`
- `budget({ maxSteps: 5 }).limits.maxSteps` === 5
- `consume({ input: 100, output: 50 })` → internal tokens = 150, steps = 1
- Multiple `consume` calls accumulate steps
- `consume({ cost: 0.5 })` with `maxDollars: 1.0` twice → second call throws `BudgetExhausted` with `code: 'budget.dollars'`
- `assertNotExhausted()` after over-budget consume throws `BudgetExhausted`
- `remaining()` returns `{ steps: 5 }` when only `maxSteps` set
- `remaining()` returns 0 (not negative) when over-consumed
- `consume` with zero inputs still increments steps

### `agent.test.ts` — replace single stub test

- Happy path: adapter returns `stopReason: 'end'` on first call → Result.ok with one terminal call, no tool steps
- Tool round trip: first call returns `stopReason: 'tool_call'` with one tool call, second call returns `stopReason: 'end'` → loop terminates with Result.ok, 1 step recorded, aggregated usage
- Tool handler throws → error text fed back as tool message; loop continues
- Unknown tool name in model's response → error text fed back; loop continues
- `options.maxSteps = 2` exceeded → `Result.error` with `code: 'agent.max_steps_exceeded'`
- Budget exhausted mid-loop → `Result.error(BudgetExhausted)` (propagates from `call`)
- `onStep` called once per step with correct shape (assistant, toolCalls, toolResults, usage)
- Lazy tools: `tools: (ctx) => [...]` invoked per step with `{ messages, step }`
- Parallel tools: model returns 3 tool calls in one response → all 3 execute (test via call-count on handler)
- Aggregated usage/cost sums correctly across multiple steps
- Assistant message with `stopReason: 'tool_call'` but empty `toolCalls` array → treated as terminal (no tool calls, loop exits)

### `call.test.ts` — add

- With budget: `call` consumes usage correctly; subsequent `call` with exceeded budget returns `Result.error(BudgetExhausted)` — NOT throw
- With budget pre-exhausted by previous consume: `call` returns `Result.error(BudgetExhausted)` from `assertNotExhausted` path before hitting adapter
- Type-level test via `expectTypeOf`: `call<{ n: number }>({ schema: numberSchema })` compiles; `call<{ n: number }>({ schema: stringSchema })` should fail

### `stream.test.ts` — add

- With budget: usage chunk triggers consume; if it exhausts, `for await` throws `BudgetExhausted`

### Existing tests must still pass

All pre-Plan-3 tests (77 after subtracting 5 budget stub tests we're rewriting) remain green.

## Out of scope for Plan 3

- Retry/backoff logic
- Streaming agent (`agent.stream()`)
- Real compress module (still stubbed; Plan 4)
- Memory integration (Plan 5)
- Checkpoint/resume for agent
- `Tool<Input, Output>`'s typed output feeding back into message content with typed hints (future nice-to-have)

## Success criteria

1. `budget()` implements throw-on-exhaustion semantics with correct codes per field
2. `agent()` drives model through tool calls until terminal, with error recovery
3. `call` returns `Result.error(BudgetExhausted)` in both pre-check and post-consume paths — never throws
4. `stream` propagates `BudgetExhausted` via throw (intentional per streaming contract)
5. `CallOptions<T>` generic enforces schema-output = `T` at compile time
6. `pnpm --filter flint test` passes with ~25 new agent/budget tests and existing ones unchanged
7. `pnpm --filter flint typecheck` zero errors
8. Tag `v0.2.0` after all checks pass
