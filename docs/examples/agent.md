# Agent Loop

Run a multi-step agent that uses tools autonomously until it reaches an answer or hits a budget limit.

```ts
import { tool, agent } from 'flint';
import { budget } from 'flint/budget';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import * as v from 'valibot';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

// Tools
const search = tool({
  name: 'search',
  description: 'Search the web for information',
  input: v.object({ query: v.string() }),
  handler: async ({ query }) => {
    // Replace with a real search API
    return `Search results for "${query}": [result 1, result 2, result 3]`;
  },
});

const calculate = tool({
  name: 'calculate',
  description: 'Evaluate a mathematical expression',
  input: v.object({ expression: v.string() }),
  handler: ({ expression }) => {
    // Use a safe math evaluator in production
    return String(Function(`return ${expression}`)());
  },
});

// Run agent
const out = await agent({
  adapter,
  model: 'claude-opus-4-7',
  messages: [
    {
      role: 'user',
      content: 'Research the population of Tokyo and calculate how many times larger it is than Paris.',
    },
  ],
  tools: [search, calculate],
  budget: budget({ maxSteps: 8, maxDollars: 0.50 }),
  onStep: (step) => {
    console.log(`Step ${step.toolCalls.length} tool calls made`);
    for (const tc of step.toolCalls) {
      console.log(`  → ${tc.name}(${JSON.stringify(tc.arguments)})`);
    }
  },
});

if (out.ok) {
  console.log('\nFinal answer:', out.value.message.content);
  console.log(`Completed in ${out.value.steps.length} steps`);
  console.log(`Total tokens: ${out.value.usage.input + out.value.usage.output}`);
  console.log(`Total cost: $${out.value.cost.toFixed(4)}`);
} else {
  console.error('Agent failed:', out.error.message);
}
```

## See also
- [agent()](/primitives/agent) — full API
- [Budget](/features/budget) — budget options
- [Testing](/guide/testing) — test agent loops
