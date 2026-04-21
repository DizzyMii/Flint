# agent()

Run an agentic loop: the model reasons, calls tools, receives results, and repeats until it reaches a terminal state or a budget limit is hit.

## Signature

```ts
function agent(options: AgentOptions): Promise<Result<AgentOutput>>
```

## AgentOptions

```ts
type AgentOptions = {
  // Required
  adapter: ProviderAdapter;
  model: string;
  messages: Message[];
  budget: Budget;

  // Optional
  tools?: ToolsParam;
  maxSteps?: number;
  onStep?: (step: Step) => void;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
};

type ToolsParam = Tool[] | ((ctx: ToolsCtx) => Tool[] | Promise<Tool[]>);
type ToolsCtx = { messages: Message[]; step: number };
```

| Option | Type | Required | Description |
|---|---|---|---|
| `adapter` | `ProviderAdapter` | Yes | LLM provider adapter |
| `model` | `string` | Yes | Model identifier |
| `messages` | `Message[]` | Yes | Initial conversation history |
| `budget` | `Budget` | **Yes** | Hard cap on steps, tokens, or dollars |
| `tools` | `ToolsParam` | No | Available tools; can be a function for dynamic tools |
| `maxSteps` | `number` | No | Additional step cap (budget's `maxSteps` is the primary cap) |
| `onStep` | `(step: Step) => void` | No | Called after each completed step |
| `compress` | `Transform` | No | Message transform applied before each call |
| `logger` | `Logger` | No | Debug logger |
| `signal` | `AbortSignal` | No | Cancellation signal |

## AgentOutput

```ts
type AgentOutput = {
  message: Message & { role: 'assistant' };
  steps: Step[];
  usage: Usage;   // aggregated across all steps
  cost: number;   // aggregated across all steps
};

type Step = {
  messagesSent: Message[];
  assistant: Message & { role: 'assistant' };
  toolCalls: ToolCall[];
  toolResults: Array<Message & { role: 'tool' }>;
  usage: Usage;
  cost?: number;
};
```

## Return value

`Promise<Result<AgentOutput>>` — never throws.

Failure cases:
- `BudgetExhausted` — any budget limit was hit
- `AdapterError` — network or API error
- `FlintError` with code `'agent.max_steps_exceeded'` — `maxSteps` was reached without a terminal response

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
  handler: async ({ query }) => `Results for: ${query}`,
});

const out = await agent({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Find the latest TypeScript release.' }],
  tools: [search],
  budget: budget({ maxSteps: 10, maxDollars: 0.50 }),
  onStep: (step) => {
    console.log(`Step ${step.toolCalls.length} tool calls`);
  },
});

if (out.ok) {
  console.log(out.value.message.content);
  console.log(`Completed in ${out.value.steps.length} steps`);
  console.log(`Total cost: $${out.value.cost.toFixed(4)}`);
}
```

## Dynamic tools

Pass a function instead of an array to supply different tools per step:

```ts
const out = await agent({
  adapter,
  model: 'claude-opus-4-7',
  messages,
  tools: ({ step }) => step < 3 ? [searchTool] : [searchTool, writeTool],
  budget: budget({ maxSteps: 6 }),
});
```

## See also

- [budget()](/features/budget) — create and configure budgets
- [call()](/primitives/call) — single-step variant used internally by `agent()`
- [Compress & Pipeline](/features/compress) — reduce message size between steps
- [Recipes](/features/recipes) — higher-level patterns built on `agent()`
