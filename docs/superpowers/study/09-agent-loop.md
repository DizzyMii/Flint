# 09 — The Agent Loop

**Source:** `packages/flint/src/agent.ts`
**See also:** Doc 06 (call primitive), Doc 07 (budget), Doc 08 (compress)

## Step

```ts
export type Step = {
  messagesSent: Message[];
  assistant: Message & { role: 'assistant' };
  toolCalls: ToolCall[];
  toolResults: Array<Message & { role: 'tool' }>;
  usage: Usage;
  cost?: number;
};
```

A `Step` captures a single tool-using iteration — the round trip from sending a message array to receiving tool results. It records six fields:

**`messagesSent`** is the accumulated `messages` array at the end of step N — after the assistant message and all tool result messages from step N have been appended. It is constructed as `[...messages]` — a shallow copy taken at that point. The copy is essential for replay fidelity: by the time the caller inspects a `Step`, the live `messages` array has grown by however many subsequent turns occurred. A reference to the live array would silently show future state. A snapshot means `step.messagesSent` is a point-in-time record of the conversation state after step N completed — you can use it to understand exactly what context step N+1 will receive, or to re-run from that point independently.

Note the placement: `messagesSent` is captured after both the assistant message and all tool results from step N have been pushed onto `messages`. This means `step.messagesSent` represents the state after step N completes — it contains everything through and including step N's tool results.

**`assistant`** is the raw assistant message returned by `call` at this iteration. Typed as `Message & { role: 'assistant' }` — the intersection is enforced at the source because `call` always returns `resp.message` which the adapter constructs with `role: 'assistant'`. Storing this separately (rather than finding it in `messagesSent`) makes the tool-call extraction obvious without needing to search the snapshot array.

**`toolCalls`** is the array from `message.toolCalls ?? []`. These are the raw `ToolCall` objects as the adapter returned them — name, id, and raw arguments — before any parsing or validation. Storing raw tool calls on the step means errors in `execute` can be correlated against what the model actually requested.

**`toolResults`** is the parallel output of `runToolCall` for each tool call. Each element is a `Message & { role: 'tool' }` carrying the serialized result or error string and the `toolCallId` that links it back to its originating `ToolCall`.

**`usage`** and **`cost?`** are the per-iteration token and dollar figures from `call`. Storing them per-step allows attribution of cost to specific turns rather than just the aggregate total.

## AgentOutput

```ts
export type AgentOutput = {
  message: Message & { role: 'assistant' };
  steps: Step[];
  usage: Usage;
  cost: number;
};
```

`AgentOutput` is the value inside `Result<AgentOutput>` returned when the agent terminates normally (i.e. the model returns a response with no tool calls).

**`message`** is the terminal assistant message — the final response that contained no tool calls and no `stopReason === 'tool_call'`. This is always the last message the model produced, never an intermediate one.

**`steps`** is the complete ordered trace of all non-terminal iterations. An agent that required zero tool calls has `steps: []`. Each `Step` in the array corresponds exactly to one tool-using round trip, in chronological order. The length of `steps` tells you how many model-tool-model cycles occurred before the model decided to stop.

**`usage`** is the aggregated `Usage` across all steps plus the terminal call — see `aggregateUsage` below. Note the return type has `usage: Usage` not `usage?: Usage`, so it is always present.

**`cost`** is typed `number`, not `number | undefined`. `aggregateCost` always returns a `number` — it defaults to `0` when no step or terminal call reported a cost. This means callers can safely read `output.cost` without a nullability check; a cost of `0` means the adapter never reported pricing data, not that the run was free.

## ToolsCtx

```ts
export type ToolsCtx = { messages: Message[]; step: number };
```

Context threaded to a lazy `tools` function. `messages` is the current live accumulator (the same reference the loop builds, not a copy) — the function can inspect the full conversation history to decide which tools to expose. `step` is `steps.length` at the point of resolution, i.e. 0 for the first iteration, 1 for the second. `steps.length` equals the number of tool-using turns that have completed so far — this is exactly the information a dynamic tool factory needs to reason about what stage the agent is in, for example providing a different tool set on the first iteration versus subsequent ones. A lazy tool function can use both fields: for example, returning a restricted tool set for the first call and expanding it after the model has gathered initial information.

## ToolsParam

```ts
export type ToolsParam = Tool[] | ((ctx: ToolsCtx) => Tool[] | Promise<Tool[]>);
```

Two forms: a static array or a factory function. The factory can return synchronously or asynchronously.

**Why lazy tool sets exist.** The tool list available to an agent often depends on runtime state that cannot be captured at call site: the authenticated user's permissions, which external services are reachable, which resources have been fetched in earlier steps. A static `Tool[]` fixes the tool surface at invocation time. A lazy function recalculates on every iteration, so if step 3 fetched a list of available database tables, step 4's tool resolution can expose per-table query tools that step 1 could not have known about. The factory receives `ToolsCtx` (current messages and step index) so the selection logic can be context-sensitive, not just a fixed computation deferred to runtime.

The resolution in the loop is:

```ts
const tools: Tool[] =
  options.tools === undefined
    ? []
    : typeof options.tools === 'function'
      ? await options.tools({ messages, step: steps.length })
      : options.tools;
```

`undefined` tools resolves to `[]` — an agent without tools is valid; it will run one-turn and exit. Static arrays are used as-is. Lazy functions are `await`-ed, so async tool resolution (e.g. fetching permitted tools from an auth service) is first-class.

## AgentOptions

```ts
export type AgentOptions = {
  adapter: ProviderAdapter;
  model: string;
  messages: Message[];
  tools?: ToolsParam;
  budget: Budget;
  maxSteps?: number;
  onStep?: (step: Step) => void;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
};
```

**`budget: Budget` — required, not optional.** On the `call` primitive, `budget` is `budget?: Budget`. On `agent`, it is required. The agent loop can cycle indefinitely if the model keeps requesting tool calls; without a budget, there is no automatic stopping condition beyond `maxSteps`. Making `budget` required forces callers to set explicit resource limits before starting a potentially unbounded loop. A caller that genuinely wants no budget can pass a budget with arbitrarily large limits, but they must make that choice explicitly rather than accidentally.

**`maxSteps?: number`** — defaults to `Number.POSITIVE_INFINITY`. With an infinite default, `maxSteps` as a standalone safeguard is toothless — the budget is the real hard limit. `maxSteps` exists for callers who want to cap loop depth independently of cost/token budgets (e.g. integration tests that should never run more than 5 steps regardless of budget).

**`onStep?: (step: Step) => void`** — called synchronously after each non-terminal step is pushed to `steps`. The return value is not `await`-ed — the callback is fire-and-forget. This is intentional: a slow `onStep` (e.g. writing a step to a database) must not stall the agent loop. Callers that need async step handling must manage that internally.

Important caveat: a synchronously throwing `onStep` callback will crash the agent loop — the source has no try/catch around the `options.onStep?.(step)` call. Async errors are treated differently: if `onStep` returns a rejected Promise, it is silently dropped because the call is not awaited. The distinction matters: sync throw = agent crash, async throw = silent drop.

**`compress?: Transform`** — forwarded verbatim to each `call` invocation. The same transform runs on every iteration. The compress pipeline sees the full accumulated `messages` array before each call, so transforms like `windowLast` and `dedup` naturally adapt to the growing history.

**`signal?: AbortSignal`** — forwarded to each `call`, which passes it to the adapter. Cancellation aborts the in-flight adapter request; any already-completed tool executions in the same step are not undone. If the signal fires mid-`Promise.all` over tool calls, only the `call` that follows will check it — there is no cancellation propagation into individual tool handlers via this signal. Specifically: once `Promise.all` is entered for parallel tool execution, tool handlers run to completion regardless of the signal. There is no mid-execution interrupt. A slow handler will not be stopped by an abort — cancellation only takes effect at the next `call` inside the adapter, after all tool results have been collected.

**`logger?`** — forwarded to `call`. The agent itself emits no logs; all logging happens inside the `call` primitive and the adapter.

**`system?`** — not present. System messages are passed as part of `messages`, using `{ role: 'system', content: '...' }` entries, not a separate field. This is consistent with how the `call` primitive works: there is no top-level `system` parameter anywhere in the stack.

## runToolCall

```ts
async function runToolCall(tc: ToolCall, tools: Tool[]): Promise<Message & { role: 'tool' }>`
```

**Tool lookup** is a linear scan: `tools.find((t) => t.name === tc.name)`. The tools array is the freshly resolved array from this iteration; the lookup is by exact string match on `name`.

**Unknown tool → error string returned, not thrown.** When no tool matches `tc.name`, `runToolCall` returns:

```ts
{ role: 'tool', content: `Error: unknown tool "${tc.name}"`, toolCallId: tc.id }
```

This is a deliberate design choice. The model may hallucinate a tool name that was never in the schema, or the tool list may have changed between the iteration that produced the tool call and the `runToolCall` invocation (rare, but possible with lazy tools). Throwing an exception would crash the agent. Returning an error string to the model as a tool result gives it a chance to observe "I called a tool that doesn't exist" and recover — it might correct its output, try a different tool, or respond without tool use. Crashing the agent on every tool hallucination would make the agent brittle against a common and correctable model failure mode.

**`execute` result → string serialization.** On success, `execute` returns `Result<Output>` where `Output` is the typed return of the tool handler. `runToolCall` converts to string:

```ts
const content =
  typeof execResult.value === 'string' ? execResult.value : JSON.stringify(execResult.value);
```

String output is used verbatim. Non-string output is `JSON.stringify`-ed. The model receives strings, so all tool results must be text; JSON serialization is the universal bridge for structured output. Handlers that return primitives (numbers, booleans) go through the `else` branch and are stringified as their JSON literal form.

**Error message concatenation.** On failure, `execute` returns a `ToolError`, `ParseError`, or `TimeoutError`. The handling in `runToolCall` uses the same error-string path for all three:

```ts
let errorMsg = execResult.error.message;
if (execResult.error.cause instanceof Error) {
  errorMsg += `: ${execResult.error.cause.message}`;
}
return { role: 'tool', content: `Error: ${errorMsg}`, toolCallId: tc.id };
```

There is a third failure mode beyond `ToolError` and `ParseError`: when a tool's `timeout` fires, `execute` returns `{ ok: false, error: TimeoutError }` directly — it is not wrapped in a `ToolError`. The `TimeoutError` message (e.g. `Tool "foo" timed out after 5000ms`) becomes `errorMsg`. Because `TimeoutError` has no `cause` set (the code constructs it without one), the `instanceof Error` branch is never entered — the model receives only the timeout message, with no concatenated cause. This differs from the `ToolError` path, where the underlying cause message is appended when present.

Two levels of error text are surfaced for `ToolError`/`ParseError`: the wrapper message (e.g. `Tool "search" handler threw`) and the underlying cause message (e.g. `ECONNREFUSED`). The model sees both, which gives it more signal about what failed. A single-level error message would often be too generic to be actionable. The check `instanceof Error` guards against causes that are non-Error throwables (strings, objects) — in those cases only the wrapper message is used.

## aggregateUsage

```ts
function aggregateUsage(steps: Step[], terminal: Usage): Usage {
  let input = terminal.input;
  let output = terminal.output;
  let cached = terminal.cached ?? 0;
  for (const s of steps) {
    input += s.usage.input;
    output += s.usage.output;
    cached += s.usage.cached ?? 0;
  }
  return cached > 0 ? { input, output, cached } : { input, output };
}
```

Sums `input`, `output`, and `cached` across all steps and the terminal call. The accumulation starts from the terminal call's usage (not zero) and adds each step's usage on top — order does not matter since it is pure addition.

**`cached` included only if > 0.** The `cached` field on `Usage` is `cached?: number` (optional). If no step or terminal call had any cache hits, the aggregate `cached` accumulator stays at `0`. The return uses a conditional to omit the field entirely: `cached > 0 ? { input, output, cached } : { input, output }`. The rationale is that `cached: 0` is meaningless and would be confusing — it could imply caching was attempted but got no hits, or that caching is not supported. Omitting it signals "caching contributed nothing to this run." Callers checking for cache activity should check `usage.cached !== undefined` rather than `usage.cached > 0`.

## aggregateCost

```ts
function aggregateCost(steps: Step[], terminal: number | undefined): number {
  let total = terminal ?? 0;
  for (const s of steps) {
    total += s.cost ?? 0;
  }
  return total;
}
```

Sums `cost` across all steps and the terminal call. Steps with no cost (adapter did not report pricing) contribute `0`. Terminal call with no cost also contributes `0`. The function always returns a `number`.

**`undefined` when no step had a cost — translated to 0.** Unlike `aggregateUsage`'s handling of `cached`, `aggregateCost` does not propagate `undefined` — it always returns `number`. The caller (`agent`) stores the result directly in `AgentOutput.cost: number`. The design accepts a loss of signal: a cost of `0` on `AgentOutput` is ambiguous between "the adapter reported zero cost" and "the adapter never reported cost at all." This is a tradeoff in favor of a simpler API surface — callers always get a number and never need to branch on `undefined`. The `Step`-level `cost?: number` field preserves the per-step signal; callers that need exact attribution can inspect steps directly.

## Main loop

```ts
export async function agent(options: AgentOptions): Promise<Result<AgentOutput>> {
  const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;
  const messages: Message[] = [...options.messages];
  const steps: Step[] = [];

  while (steps.length < maxSteps) { ... }
  ...
}
```

**`messages` is initialized as a shallow copy** of `options.messages`. The agent must not mutate the caller's original array — doing so would be a surprising side effect and would corrupt any array the caller holds a reference to across multiple agent runs or concurrent uses. The copy-on-entry pattern isolates the agent's accumulator from the caller's data.

### Iteration guard

`while (steps.length < maxSteps)` — steps are counted, not iterations. One iteration that does not produce tool calls exits immediately without incrementing `steps`. The guard therefore counts tool-using turns, not total `call` invocations. With `maxSteps = 3`, the agent may make at most 4 calls to the adapter (3 tool-using turns + 1 terminal turn), and at most 3 entries in `steps` — assuming no adapter error or budget exhaustion on the terminal call; those would return `{ ok: false }` from the terminal call's result, not from the max-steps path. This is slightly subtle: a caller setting `maxSteps = 5` is not limiting adapter calls to 5, but tool-using iterations to 5.

### Lazy tool resolution per iteration

```ts
const tools: Tool[] =
  options.tools === undefined ? []
  : typeof options.tools === 'function'
    ? await options.tools({ messages, step: steps.length })
    : options.tools;
```

Executed at the top of each `while` body. Static arrays are used as-is every iteration — no allocation. Lazy functions are called and awaited every iteration. The factory sees the current `messages` (including all tool results from prior steps) and the current `step` index. If the factory is expensive, that cost is paid on every iteration; callers are responsible for caching inside the factory if needed.

### call invocation

```ts
const result = await call({
  adapter: options.adapter,
  model: options.model,
  messages,
  ...(tools.length > 0 ? { tools } : {}),
  budget: options.budget,
  ...(options.compress !== undefined ? { compress: options.compress } : {}),
  ...(options.logger !== undefined ? { logger: options.logger } : {}),
  ...(options.signal !== undefined ? { signal: options.signal } : {}),
});
```

`call` receives the full accumulated `messages` array — not a copy. `call` applies `compress` internally before forwarding to the adapter, so the agent loop never sees the compressed form. `call` also checks and consumes the budget internally; the agent loop does not touch budget accounting directly. Optional fields are conditionally spread using the `...(cond ? { key: val } : {})` pattern to avoid passing `undefined` values as explicit fields, which some adapters might misinterpret.

`tools` is only forwarded if `tools.length > 0` — if there are no tools, the key is omitted entirely from the `call` options rather than passed as an empty array. This avoids confusing adapters that might behave differently when they receive `tools: []` versus no `tools` key at all.

If `call` returns `{ ok: false }`, the agent propagates the error immediately: `return { ok: false, error: result.error }`. Budget exhaustion, adapter errors, abort signals, and parse errors all surface this way.

### Terminal branch

```ts
const hasToolCalls =
  stopReason === 'tool_call' && message.toolCalls && message.toolCalls.length > 0;

if (!hasToolCalls) {
  return {
    ok: true,
    value: {
      message,
      steps,
      usage: aggregateUsage(steps, usage),
      cost: aggregateCost(steps, cost),
    },
  };
}
```

The agent checks `stopReason === 'tool_call'` AND that `message.toolCalls` is non-empty. This double-check guards against adapters that return `stopReason: 'tool_call'` without any actual tool calls on the message (a malformed response). If either condition fails, the response is treated as terminal. The terminal assistant message has already been pushed onto `messages` before this check — so `messages` ends in the terminal assistant turn.

`aggregateUsage` and `aggregateCost` are called at this point with the terminal call's `usage` and `cost` plus all accumulated `steps`. The terminal usage is not stored as a `Step` — only tool-using turns are stored as steps.

### Parallel tool execution

```ts
const toolCalls = message.toolCalls ?? [];
const toolResults = await Promise.all(toolCalls.map((tc) => runToolCall(tc, tools)));
```

All tool calls in a single turn are dispatched concurrently via `Promise.all`. This is a significant performance optimization when a model requests multiple independent tools in one response (common). If tool A takes 2 seconds and tool B takes 3 seconds, sequential execution would take 5 seconds; parallel execution takes 3 seconds. The correctness assumption is that tool calls within a single turn are independent — the model cannot express ordering constraints in a single tool-call batch, so concurrent execution is semantically equivalent to any serial ordering. If a tool has side effects that must precede another tool's execution, the model must sequence them across separate turns.

`Promise.all` propagates the first rejection, but `runToolCall` is designed never to reject — it catches all errors from `execute` and converts them to error-content tool result messages. `Promise.all` over `runToolCall` calls therefore never rejects in practice.

### Messages accumulation

```ts
messages.push(message);               // assistant turn
// (terminal check happens here)
messages.push(...toolResults);        // tool result turns
```

The assistant message is pushed before the terminal check — this means even if the agent exits terminally, the assistant message is already in `messages`. The tool results are pushed after the tool call parallel execution completes. The order in `messages` after a non-terminal step: `...prior, assistant_message, tool_result_1, tool_result_2, ...`.

### Step record construction

```ts
const step: Step = {
  messagesSent: [...messages],   // snapshot AFTER tool results are appended
  assistant: message,
  toolCalls,
  toolResults,
  usage,
  ...(cost !== undefined ? { cost } : {}),
};
steps.push(step);
options.onStep?.(step);
```

`messagesSent` is captured after both the assistant message and all tool results have been pushed. This means `step.messagesSent` is the accumulated `messages` array at the end of step N — a complete record of the conversation state after step N completes. Because the next call will receive this same array as its starting `messages`, it is identical to what step N+1 will receive — but the framing is "state after step N" rather than "input to step N+1." The name reflects what was accumulated through this step, not a forward projection.

`onStep` is called synchronously after the step is pushed. The callback receives the same `Step` object that is now in `steps` — mutations to it by the callback would affect `steps` in place. Callers should treat the `Step` as read-only.

### Max steps exceeded path

When the `while` loop exits without having returned (i.e. `steps.length === maxSteps` and the last iteration produced tool calls):

```ts
const lastMessage = messages[messages.length - 1];
return {
  ok: false,
  error: new FlintError('Agent exceeded maxSteps without reaching a terminal response', {
    code: 'agent.max_steps_exceeded',
    cause: lastMessage,
  }),
};
```

The error carries `code: 'agent.max_steps_exceeded'` and attaches the last message in `messages` as the `cause`. The last message will be the final tool result (since the loop exited after pushing tool results but before making the next `call`). Attaching it as `cause` gives callers access to the raw last state without needing to inspect `steps` separately. The return is `{ ok: false }` — the agent loop returns a `Result` error, not a thrown exception, consistent with how budget exhaustion and adapter errors are surfaced.
