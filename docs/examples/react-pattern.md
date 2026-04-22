# ReAct Pattern

The ReAct pattern (Reason + Act) prompts the model to reason before each tool call. This improves reliability on multi-step tasks.

Flint ships a `react()` recipe that implements the pattern. Use it as a drop-in replacement for `agent()` when you need better reasoning on complex tasks.

```ts
import { tool } from 'flint';
import { react } from 'flint/recipes';
import { budget } from 'flint/budget';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import * as v from 'valibot';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const searchWeb = tool({
  name: 'search_web',
  description: 'Search the web and return a summary of results',
  input: v.object({ query: v.string() }),
  handler: async ({ query }) => `Results for "${query}": [mocked results]`,
});

const readPage = tool({
  name: 'read_page',
  description: 'Fetch and read the content of a webpage',
  input: v.object({ url: v.string() }),
  handler: async ({ url }) => `Content of ${url}: [mocked content]`,
});

const out = await react({
  adapter,
  model: 'claude-opus-4-7',
  messages: [
    {
      role: 'user',
      content: 'Find the current TypeScript version and summarize the major new features.',
    },
  ],
  tools: [searchWeb, readPage],
  budget: budget({ maxSteps: 12, maxDollars: 1.00 }),
});

if (out.ok) {
  console.log(out.value.message.content);
}
```

## How it works

`react()` injects a system prompt that instructs the model to emit a `Thought:` prefix before each action, then an `Action:` call. This structured reasoning is stripped from the final output before returning. The model's reasoning trace is available in `out.value.steps`.

## See also

- [Recipes](/features/recipes) — react() API
- [agent()](/primitives/agent) — underlying loop
