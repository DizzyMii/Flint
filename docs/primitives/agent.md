# agent()

Run an agentic loop: the model reasons, calls tools, receives results, and repeats until it reaches a terminal response or a limit is hit.

The loop is built as an **event stream**. `agentStream()` yields an `AgentEvent` for every state change and returns the final `Result`; `agent()` drains that stream for you. The same events drive streaming UIs, tracing, and crash recovery — see [Event log & resume](/features/events).

## Signatures

```ts
function agent(options: AgentOptions): Promise<Result<AgentOutput>>

function agentStream(options: AgentOptions): AsyncGenerator<AgentEvent, Result<AgentOutput>>
```

## AgentOptions

```ts
type AgentOptions = {
  // Required
  adapter: ProviderAdapter;
  model: string;
  messages: Message[];
  budget: Budget;

  // Tools
  tools?: ToolsParam;

  // Loop control & observation
  maxSteps?: number;
  onStep?: (step: Step) => void;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  logger?: Logger;

  // Context
  context?: ContextStrategy;
  compress?: Transform;

  // Passed to every call()
  streaming?: boolean;
  maxTokens?: number;
  cache?: 'auto' | 'off';
  extra?: Record<string, unknown>;
  retry?: RetryPolicy | false;
};

type ToolsParam = Tool[] | ((ctx: ToolsCtx) => Tool[] | Promise<Tool[]>);
type ToolsCtx = { messages: Message[]; step: number };
```

| Option | Type | Default | Description |
|---|---|---|---|
| `adapter` | `ProviderAdapter` | required | LLM provider adapter |
| `model` | `string` | required | Model identifier |
| `messages` | `Message[]` | required | Initial conversation history |
| `budget` | `Budget` | required | Hard cap on steps, tokens, or dollars — checked before and charged after every call |
| `tools` | `ToolsParam` | — | Static array, or a function called at the start of each step |
| `maxSteps` | `number` | `Infinity` | Extra cap on tool-using iterations (the budget's `maxSteps` is usually the primary cap) |
| `onStep` | `(step) => void` | — | Called after each completed tool-using step |
| `onEvent` | `(event) => void` | — | Receives every [`AgentEvent`](/features/events) |
| `signal` | `AbortSignal` | — | Cancels the in-flight request, running tools (via `ctx.signal`) and the loop |
| `context` | `ContextStrategy` | — | Stateful context management, e.g. [`contextManager()`](/features/context). Preferred for long runs. |
| `compress` | `Transform` | — | Stateless per-request transform (see [Compress](/features/compress)) |
| `streaming` | `boolean` | `false` | Use the adapter's streaming endpoint and emit `chunk` events |
| `maxTokens` | `number` | adapter default | Max output tokens per call (budget pre-flight may lower it) |
| `cache` | `'auto' \| 'off'` | adapter default | Prompt caching mode |
| `extra` | `object` | — | Provider body fields for every call, e.g. `{ thinking: { type: 'adaptive' } }` |
| `retry` | `RetryPolicy \| false` | 2 retries | Retry policy for transient provider errors |
| `logger` | `Logger` | — | Debug logger |

## AgentOutput

```ts
type AgentOutput = {
  message: AssistantMessage;  // final assistant message
  steps: Step[];              // completed tool-using steps
  usage: Usage;               // summed across every call, including the final one
  cost: number;               // summed USD cost
  messages: Message[];        // the full, uncompressed transcript including the initial messages
};

type Step = {
  messagesSent: Message[];    // what was actually sent, after context management and compression
  assistant: AssistantMessage;
  toolCalls: ToolCall[];
  toolResults: ToolMessage[];
  usage: Usage;
  cost?: number;
};
```

`output.messages` is ready to be extended with a new user turn to continue the conversation. It always holds the full history, even when a context manager or `compress` sent the model something shorter.

## Return value

`Promise<Result<AgentOutput>>`. Failures are returned, not thrown:

| Error | Code | When |
|---|---|---|
| `BudgetExhausted` | `budget.*` | A budget limit was hit (before a call, in pre-flight, or after a call) |
| `AdapterError` | `adapter.*` | Provider failure that retries did not fix |
| `FlintError` | `agent.max_steps_exceeded` | `maxSteps` iterations without a terminal response |
| `FlintError` | `agent.aborted` | `signal` was aborted between steps |
| `FlintError` | `budget.unpriced`, `compress.malformed` | See [call()](/primitives/call#return-value) |

Programming errors still throw: duplicate tool names (`TypeError: agent: duplicate tool name "…"`) and missing required options.

### Partial runs

A failed run keeps what it achieved. `partialRun(error)` returns the steps, transcript, usage and cost up to the failure:

```ts
import { agent, partialRun } from 'flint';

const res = await agent({ ... });
if (!res.ok) {
  const partial = partialRun(res.error);
  console.log(`failed after ${partial?.steps.length} steps, $${partial?.cost.toFixed(4)}`);
  // partial.messages can seed a retry with a bigger budget
}
```

```ts
type AgentPartial = { steps: Step[]; messages: Message[]; usage: Usage; cost: number };
```

## Example

```ts
import { tool, agent } from 'flint';
import { budget } from 'flint/budget';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import * as v from 'valibot';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const search = tool({
  name: 'search',
  description: 'Search the web',
  input: v.object({ query: v.string() }),
  jsonSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  handler: async ({ query }) => `Results for: ${query}`,
});

const out = await agent({
  adapter,
  model: 'claude-opus-5-5',
  messages: [{ role: 'user', content: 'Find the latest TypeScript release.' }],
  tools: [search],
  budget: budget({ maxSteps: 10, maxDollars: 0.50 }),
  onStep: (step) => console.log(`step: ${step.toolCalls.map((c) => c.name).join(', ')}`),
});

if (out.ok) {
  console.log(out.value.message.content);
  console.log(`Completed in ${out.value.steps.length} steps, $${out.value.cost.toFixed(4)}`);
}
```

## Streaming the loop

```ts
import { agentStream } from 'flint';

const run = agentStream({ adapter, model: 'claude-opus-5-5', messages, tools, budget: b, streaming: true });

for (;;) {
  const n = await run.next();
  if (n.done) {
    const result = n.value; // Result<AgentOutput>
    break;
  }
  const e = n.value;
  if (e.type === 'chunk' && e.chunk.type === 'text') process.stdout.write(e.chunk.delta);
  if (e.type === 'tool_start') console.log(`\n→ ${e.call.name}`);
}
```

`for await (const e of agentStream(...))` also works if you don't need the return value. The full event catalog is on the [Event log](/features/events) page.

## How a step runs

1. If `signal` is aborted, return `agent.aborted`.
2. Resolve `tools` (calling the function form with `{ messages, step }`); throw on duplicate names.
3. Build the prompt: with `context`, call `context.prepare(transcript, …)` — this may emit a `compaction` event.
4. `call()` (or `callStream()` when `streaming`) with the budget, `compress`, `retry` and pass-through options.
5. If the provider rejects the prompt as too long (`AdapterError` kind `context_overflow`) **and** a `context` strategy is set, force a compaction and retry the step once.
6. Append the assistant message. If it has no tool calls (or `stopReason !== 'tool_call'`), finish with `{ ok: true }`.
7. Run the tool calls (see below), append the results, record the `Step`, call `onStep`.

### Tool execution

- Calls in one turn run **concurrently**, unless any tool in the batch is sequential (`sequential: true`, or `permissions.destructive`), in which case the whole batch runs in order.
- Each handler gets `ctx.signal`, `ctx.toolCallId` and `ctx.step`.
- A tool call whose arguments failed to parse (`ToolCall.parseError`) is **not run**; the model receives an error result asking it to retry with valid JSON.
- Unknown tool names, validation failures, timeouts and handler exceptions become tool results with `isError: true` and content `Error: …`. The loop continues and the model decides what to do.

## Dynamic tools

Pass a function to supply different tools per step:

```ts
const res = await agent({
  ...
  tools: async ({ messages, step }) => {
    if (step === 0) return [searchTool];
    return [searchTool, writeTool];
  },
});
```

## Long runs: context and caching

Every step re-sends the whole transcript. With the Anthropic adapter's default caching, the history is read from cache at a tenth of the input price, which is usually the cheapest option. When the transcript approaches the model's window, add a context manager:

```ts
import { contextManager } from 'flint/context';
import { anthropicPricing } from '@flint/adapter-anthropic';

const out = await agent({
  adapter,
  model: 'claude-opus-5-5',
  messages,
  tools,
  budget: budget({ maxSteps: 100, maxDollars: 10 }),
  context: contextManager({
    summarizer: { adapter, model: 'claude-opus-5-5' },
    contextWindow: 200_000,
    pricing: anthropicPricing['claude-opus-5-5']!,
  }),
});
```

See [Context management](/features/context) for when compaction pays off.

## Multi-turn continuation

Continue from a finished run by appending to `output.messages`:

```ts
const first = await agent({ adapter, model, messages, tools, budget: b });
if (first.ok) {
  const second = await agent({
    adapter,
    model,
    messages: [...first.value.messages, { role: 'user', content: 'Now read the README' }],
    tools,
    budget: b,
  });
}
```

To resume after a crash, rebuild the transcript from an event log with `transcriptFrom()` — see [Event log & resume](/features/events#crash-resume).

## See also

- [Event log & resume](/features/events) — events, JSONL persistence, crash resume, tracing
- [Context management](/features/context) — `contextManager()`
- [call()](/primitives/call) — single-step variant
- [Budget](/features/budget) — required — step/token/dollar limits
- [Testing](/guide/testing) — scripted adapters and record/replay
