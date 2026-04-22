# Flint vs LangChain

This page is a technical comparison for developers who know LangChain and want to understand the differences in depth. It covers philosophy, dependencies, error handling, schema support, streaming, budget enforcement, safety, and prompt caching — with working code for each.

## Philosophy

LangChain models the AI stack as composable objects. An `LLM` is a class instance, a `Chain` is an object that wraps other objects, an `AgentExecutor` orchestrates `Tool` instances. You learn LangChain's abstractions, then use them to call models.

Flint models the AI stack as composable functions. `call()`, `tool()`, `agent()` are plain async functions that accept plain objects and return plain objects. There is no framework class hierarchy to learn — TypeScript is the glue. The consequence: Flint code looks like TypeScript code, not LangChain code. It's easier to test, debug, and read call stacks.

The tradeoff: LangChain's abstraction layer unlocks a large ecosystem of integrations (vector stores, document loaders, output parsers, callbacks). If you need those integrations quickly, LangChain's ecosystem is hard to beat. If you want full control and minimal surface area, Flint gives you that.

## Dependencies

**LangChain** uses a split-package model. A minimal Anthropic agent requires at least three packages:

```sh
npm install langchain @langchain/anthropic @langchain/core
```

Each of these has its own transitive dependency tree. A fresh install pulls in dozens of packages.

**Flint** requires two packages:

```sh
npm install flint @flint/adapter-anthropic
```

`flint` has one runtime dependency: `@standard-schema/spec`, a zero-dependency spec package with no runtime code. `@flint/adapter-anthropic` has zero runtime dependencies — it uses `fetch` and `ReadableStream` directly.

## Error handling

**LangChain** surfaces errors as thrown exceptions. You need try/catch at every `invoke()` call:

```ts
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage } from '@langchain/core/messages';

const llm = new ChatAnthropic({ model: 'claude-opus-4-7', apiKey: process.env.ANTHROPIC_API_KEY });

try {
  const res = await llm.invoke([new HumanMessage('What is 2 + 2?')]);
  console.log(res.content);
} catch (err) {
  // What type is err? Unknown. Could be a network error, auth error, rate limit...
  console.error(err);
}
```

**Flint** returns `Result<T>` everywhere — `{ ok: true, value }` or `{ ok: false, error }`. Errors are typed and part of the function signature. You cannot forget to handle them because the `value` is only accessible after the `ok` check:

```ts
import { call } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'What is 2 + 2?' }],
});

if (!res.ok) {
  // res.error is typed as Error (narrowable to AdapterError, BudgetExhausted, etc.)
  console.error(res.error.message);
} else {
  console.log(res.value.message.content); // "4"
}
```

See [Error Types](/reference/errors) for the full error catalog.

## Schema and validation

**LangChain** tools are Zod-only. The `tool()` helper from `@langchain/core/tools` requires a Zod schema:

```ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const add = tool(({ a, b }) => String(a + b), {
  name: 'add',
  description: 'Add two numbers',
  schema: z.object({ a: z.number(), b: z.number() }),
});
```

**Flint** tools use [Standard Schema](https://standardschema.dev) — any compatible library works: Zod, Valibot, ArkType, Effect Schema. You're not locked to a validator:

```ts
import { tool } from 'flint';
import * as v from 'valibot'; // or z from 'zod', or Type from 'arktype'

const add = tool({
  name: 'add',
  description: 'Add two numbers',
  input: v.object({ a: v.number(), b: v.number() }),
  handler: ({ a, b }) => a + b, // returns number, not stringified
});
```

Note that Flint tool handlers return their native type. The runtime serializes output automatically.

## Streaming

**LangChain** streams via `streamEvents()` or the `.stream()` method, which returns an `AsyncIterable` of events:

```ts
const stream = await llm.stream([new HumanMessage('Tell me a story')]);
for await (const chunk of stream) {
  process.stdout.write(chunk.content as string);
}
```

**Flint** streams via `stream()` returning `AsyncIterable<StreamChunk>`. Each chunk is typed and carries semantic meaning:

```ts
import { stream } from 'flint';

const chunks = stream({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Tell me a story' }],
});

for await (const chunk of chunks) {
  if (chunk.type === 'text') process.stdout.write(chunk.delta);
  if (chunk.type === 'usage') console.log(`Tokens: ${chunk.usage.input + chunk.usage.output}`);
  if (chunk.type === 'end') console.log(`Stop reason: ${chunk.reason}`);
}
```

`StreamChunk` variants: `text`, `tool_call`, `usage`, `end`. See [stream()](/primitives/stream).

## Budget enforcement

**LangChain** has no built-in token or dollar budget enforcement. You track usage manually if at all.

**Flint's** `agent()` loop requires a `budget` argument and enforces hard caps:

```ts
import { agent, tool } from 'flint';
import { budget } from 'flint/budget';
import * as v from 'valibot';

const b = budget({ maxSteps: 5, maxTokens: 10_000, maxDollars: 0.10 });

const res = await agent({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Research quantum computing' }],
  tools: [searchTool],
  budget: b,
});

if (!res.ok) {
  // res.error might be BudgetExhausted if the agent ran out of budget
}

console.log(`Used: $${(0.10 - (b.remaining().dollars ?? 0)).toFixed(4)}`);
```

You can reuse the same budget across multiple agent calls — useful for enforcing a per-session cap.

## Safety

LangChain does not include safety primitives in core. Injection detection, redaction, and approval gates are third-party concerns.

**Flint ships safety in core:**

```ts
import { detectInjection, redact, requireApproval, trustBoundary } from 'flint/safety';

// Scan tool results for prompt injection attempts
const risk = detectInjection(toolOutput);
if (risk.score > 0.7) throw new Error('Injection attempt detected');

// Strip secrets before sending to LLM
const clean = redact(userMessage); // removes API keys, emails, SSNs

// Gate destructive tools behind a human approval step
const approvedTools = requireApproval(dangerousTools, async (toolName, input) => {
  return await askUser(`Allow ${toolName}(${JSON.stringify(input)})?`);
});

// Wrap an adapter to auto-detect injection on every response
const safeAdapter = trustBoundary(adapter, { threshold: 0.7 });
```

See [Safety](/features/safety) for the full API.

## Prompt caching

**LangChain** supports caching but requires explicit configuration per model.

**Flint's Anthropic adapter** is prompt-cache aware by default. It automatically adds `cache_control` breakpoints at system prompt boundaries when the model supports it. You don't configure anything:

```ts
import { anthropicAdapter } from '@flint/adapter-anthropic';

// Cache is automatic — no configuration needed
const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });
```

On cache hits, `usage.cached` is populated and the cost is reduced. See [Anthropic Adapter](/adapters/anthropic).

## Agent loop

**LangChain** (modern tool-calling agent):

```ts
import { ChatAnthropic } from '@langchain/anthropic';
import { AgentExecutor, createToolCallingAgent } from 'langchain/agents';
import { ChatPromptTemplate } from '@langchain/core/prompts';
// add tool defined in previous snippet

const llm = new ChatAnthropic({ model: 'claude-opus-4-7', apiKey: process.env.ANTHROPIC_API_KEY });
const prompt = ChatPromptTemplate.fromMessages([
  ['system', 'You are a helpful assistant.'],
  ['placeholder', '{chat_history}'],
  ['human', '{input}'],
  ['placeholder', '{agent_scratchpad}'],
]);
const agentObj = createToolCallingAgent({ llm, tools: [add], prompt });
const executor = new AgentExecutor({ agent: agentObj, tools: [add] });
const result = await executor.invoke({ input: 'What is 123 + 456?' });
console.log(result.output); // "579"
```

**Flint:**

```ts
import { agent } from 'flint';
import { budget } from 'flint/budget';
// adapter and add defined above

const out = await agent({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'What is 123 + 456?' }],
  tools: [add],
  budget: budget({ maxSteps: 5, maxDollars: 0.10 }),
});
if (out.ok) console.log(out.value.message.content); // "579"
```

## When to choose LangChain

- You need ecosystem integrations: dozens of vector stores, document loaders, output parsers
- Your team already has LangChain expertise
- You want LCEL chain composition patterns
- You need LangSmith tracing out of the box

## When to choose Flint

- You want minimal dependencies and zero framework magic
- You prefer plain functions over class hierarchies
- You need hard budget enforcement built in
- You want `Result<T>` instead of thrown exceptions
- Safety primitives (injection detection, redaction, approval gates) matter to you
- You want full control over how prompts are composed and compressed

## See also

- [Quick Start](/guide/quick-start) — get running in 5 minutes
- [agent()](/primitives/agent) — full agent loop API
- [Budget](/features/budget) — step, token, and dollar enforcement
- [Safety](/features/safety) — injection detection, redaction, approval gates
- [Adapters](/adapters/anthropic) — provider setup
