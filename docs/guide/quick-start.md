# Quick Start

## One-shot call

The simplest thing you can do with Flint: send a message, get a response.

```ts
import { call } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});

if (res.ok) {
  console.log(res.value.message.content); // "Paris"
} else {
  console.error(res.error.message);
}
```

`call()` always returns `Result<CallOutput>` — check `res.ok` before accessing `res.value`.

## Define a tool

Tools are plain objects with a typed input schema and a handler function.

```ts
import { tool } from 'flint';
import * as v from 'valibot'; // any Standard Schema library works (Zod, ArkType, etc.)

const add = tool({
  name: 'add',
  description: 'Add two numbers together',
  input: v.object({ a: v.number(), b: v.number() }),
  handler: ({ a, b }) => a + b,
});
```

## Agent loop with budget

Use `agent()` to run a tool-using loop. The `budget` argument is required — it enforces hard caps on steps, tokens, and dollars.

```ts
import { call, tool, agent } from 'flint';
import { budget } from 'flint/budget';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import * as v from 'valibot';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const add = tool({
  name: 'add',
  description: 'Add two numbers',
  input: v.object({ a: v.number(), b: v.number() }),
  handler: ({ a, b }) => a + b,
});

const out = await agent({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'What is 123 + 456?' }],
  tools: [add],
  budget: budget({ maxSteps: 5, maxDollars: 0.10 }),
});

if (out.ok) {
  console.log(out.value.message.content); // "579"
  console.log(`Used ${out.value.steps.length} steps`);
} else {
  console.error(out.error.message);
}
```

## Stream a response

Use `stream()` when you want tokens as they arrive.

```ts
import { stream } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

for await (const chunk of stream({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Count to five, slowly.' }],
})) {
  if (chunk.type === 'text') process.stdout.write(chunk.delta);
}
```

## What just happened?

In the basic call example:
1. `anthropicAdapter()` creates a transport layer — pure `fetch`, no HTTP library
2. `call()` sends your messages to the Anthropic API and returns `Result<CallOutput>`
3. `res.ok` is `true` when the API call succeeded and any schema validation passed
4. `res.value.message.content` is the assistant's text response

In the agent loop example:
1. `budget({ maxSteps: 5, maxDollars: 0.10 })` creates a shared spending cap
2. `agent()` loops: call → execute tools → call again, until no tool calls or budget hit
3. `out.value.steps` contains every tool call and result from the loop
4. `out.value.usage` is the total token usage across all steps

## Common next steps

- Add more tools → [tool()](/primitives/tool)
- Handle errors by type → [Error Types](/reference/errors)
- Stream responses → [stream()](/primitives/stream)
- Enforce budgets → [Budget](/features/budget)
- Add safety → [Safety](/features/safety)

## Next steps

- [Primitives reference](/primitives/call) — full API for `call`, `stream`, `validate`, `tool`, `execute`, `count`
- [Agent loop & budget](/primitives/agent) — complete `agent()` options
- [Compress & pipeline](/features/compress) — reduce token usage with message transforms
- [Safety](/features/safety) — injection detection, redaction, approval gates

## See also

- [Flint vs LangChain](/guide/vs-langchain) — coming from another framework?
- [FAQ](/guide/faq) — design questions answered
- [Examples](/examples/basic-call) — more complete examples
