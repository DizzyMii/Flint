# Tool Use

Define tools and let the model call them.

```ts
import { call, tool } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import * as v from 'valibot';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

// Tool definitions
const multiply = tool({
  name: 'multiply',
  description: 'Multiply two numbers',
  input: v.object({ a: v.number(), b: v.number() }),
  handler: ({ a, b }) => a * b,
});

const currentTime = tool({
  name: 'current_time',
  description: 'Get the current UTC time',
  input: v.object({}),
  handler: () => new Date().toISOString(),
});

// Single call with tools (model may call a tool, then you handle the result)
const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'What is 123 × 456?' }],
  tools: [multiply],
});

if (res.ok) {
  console.log('Stop reason:', res.value.stopReason); // 'tool_call'
  console.log('Tool calls:', res.value.message.toolCalls);
}
```

For automatic tool execution in a loop, use [agent()](/examples/agent).

## See also
- [tool()](/primitives/tool) — full tool spec
- [execute()](/primitives/execute) — test tools directly
- [agent()](/primitives/agent) — tool-using loop
