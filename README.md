<p align="center">
  <img src="flint.png" width="100%" alt="Flint" />
</p>

<p align="center">Token-efficient agentic TypeScript runtime</p>

<p align="center">
  <a href="https://www.npmjs.com/package/flint"><img src="https://img.shields.io/npm/v/flint?color=blue&label=npm" alt="npm version"></a>
  <a href="https://github.com/DizzyMii/flint/actions/workflows/ci.yml"><img src="https://github.com/DizzyMii/flint/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://img.shields.io/badge/license-MIT-blue"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
  <a href="https://img.shields.io/badge/node-%E2%89%A520-brightgreen"><img src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen" alt="node >=20"></a>
  <a href="https://img.shields.io/badge/TypeScript-5.7-blue"><img src="https://img.shields.io/badge/TypeScript-5.7-blue" alt="TypeScript 5.7"></a>
</p>

<p align="center">
  <a href="https://dizzymii.github.io/flint">Docs</a> ·
  <a href="https://dizzymii.github.io/flint/primitives/call">API Reference</a> ·
  <a href="https://dizzymii.github.io/flint/examples/basic-call">Examples</a>
</p>

---

Six primitives. One agent loop. No magic. **Flint** gives you well-typed building blocks for AI agents in TypeScript — and stays out of the way. JavaScript is the runtime; Flint gives you the tools.

## Install

```sh
npm install flint @flint/adapter-anthropic
```

## Quick start

```ts
import { call, tool, agent } from 'flint';
import { budget } from 'flint/budget';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import * as v from 'valibot'; // any Standard Schema library works

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

// One-shot call
const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});
if (res.ok) console.log(res.value.message.content); // "Paris"

// Define a tool
const add = tool({
  name: 'add',
  description: 'Add two numbers',
  input: v.object({ a: v.number(), b: v.number() }),
  handler: ({ a, b }) => a + b,
});

// Agent loop with budget enforcement
const out = await agent({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'What is 123 + 456?' }],
  tools: [add],
  budget: budget({ maxSteps: 5, maxDollars: 0.10 }),
});
if (out.ok) console.log(out.value.message.content); // "579"
```

## What you get

### Core (`flint`)

- 1 runtime dependency (`@standard-schema/spec`)
- 6 primitives: `call`, `stream`, `validate`, `tool`, `execute`, `count`
- `agent()` loop with step / token / dollar budget caps
- 6 compress transforms + `pipeline()` combinator: `dedup`, `windowLast`, `windowFirst`, `truncateToolResults`, `summarize`, `orderForCache`
- 4 recipes: `react` (ReAct pattern), `retryValidate`, `reflect`, `summarize`
- RAG: chunk, store, retrieve
- Conversation memory with async summarization
- Safety: injection detection, redaction, permissions, approval gates, boundary wrapping

### Adapters (zero runtime dependencies each)

- `@flint/adapter-anthropic` — prompt-cache aware, pure `fetch` + `ReadableStream`
- `@flint/adapter-openai-compat` — any OpenAI-compatible endpoint (OpenAI, Groq, Ollama, DeepSeek, Together)

### Graph

- `@flint/graph` — state-machine workflows with memory checkpointing

### Platform

- Node 20+ · Web API primitives only (`fetch`, `ReadableStream`, `TextDecoder`)

## Packages

| Package | Description |
|---|---|
| `flint` | Core primitives, agent loop, compress, memory, RAG, safety, recipes |
| `@flint/adapter-anthropic` | Anthropic Messages API — prompt-cache aware |
| `@flint/adapter-openai-compat` | Any OpenAI-compatible endpoint |
| `@flint/graph` | State-machine agent workflows |

## Flint vs LangChain

LangChain models everything as a class hierarchy — LLMs, chains, tools, and agents are objects you instantiate and compose. You learn LangChain's abstractions, then use them to talk to models. Flint is plain async functions: `call`, `tool`, `agent`. You learn the provider API once; Flint adds thin, well-typed helpers on top. LangChain's modular package system means installing 3+ packages with dozens of transitive dependencies per provider; Flint has one runtime dependency (`@standard-schema/spec`). Where LangChain's executor surfaces errors as thrown exceptions, Flint returns `Result<T>` — no try/catch at call sites.

### Install

**LangChain**
```sh
npm install langchain @langchain/anthropic @langchain/core
```

**Flint**
```sh
npm install flint @flint/adapter-anthropic
```

### Basic LLM call

**LangChain**
```ts
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage } from '@langchain/core/messages';

const llm = new ChatAnthropic({
  model: 'claude-opus-4-7',
  apiKey: process.env.ANTHROPIC_API_KEY,
});
const res = await llm.invoke([new HumanMessage('What is the capital of France?')]);
console.log(res.content); // "Paris"
```

**Flint**
```ts
import { call } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });
const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});
if (res.ok) console.log(res.value.message.content); // "Paris"
```

### Tool definition

**LangChain**
```ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const add = tool(({ a, b }) => String(a + b), {
  name: 'add',
  description: 'Add two numbers',
  schema: z.object({ a: z.number(), b: z.number() }),
});
```

**Flint**
```ts
import { tool } from 'flint';
import * as v from 'valibot'; // any Standard Schema library works

const add = tool({
  name: 'add',
  description: 'Add two numbers',
  input: v.object({ a: v.number(), b: v.number() }),
  handler: ({ a, b }) => a + b,
});
```

### Agent loop

**LangChain**
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
const agent = createToolCallingAgent({ llm, tools: [add], prompt });
const executor = new AgentExecutor({ agent, tools: [add] });
const result = await executor.invoke({ input: 'What is 123 + 456?' });
console.log(result.output); // "579"
```

**Flint**
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

## Why Flint

- **One dependency** — `@standard-schema/spec` only. No transitive framework sprawl.
- **No classes, no chains** — plain functions that compose naturally.
- **Standard Schema** — bring Zod, Valibot, ArkType, or any compatible library.
- **Budget-aware** — every agent loop enforces step, token, and dollar limits.
- **Streaming first** — `AsyncIterable<StreamChunk>` throughout.
- **Safety in core** — injection detection, redaction, and approval gates are not an afterthought.
- **Results, not exceptions** — `Promise<Result<T>>` everywhere; no try/catch at the call site.

## Documentation

Full documentation at **[dizzymii.github.io/flint](https://dizzymii.github.io/flint)**:

- [Guide](https://dizzymii.github.io/flint/guide/) — installation, quick start, stability notes
- [Primitives](https://dizzymii.github.io/flint/primitives/call) — `call`, `stream`, `validate`, `tool`, `execute`, `count`, `agent`
- [Features](https://dizzymii.github.io/flint/features/budget) — budget, compress, memory, RAG, recipes, safety, graph
- [Adapters](https://dizzymii.github.io/flint/adapters/anthropic) — Anthropic, OpenAI-compatible, custom
- [Examples](https://dizzymii.github.io/flint/examples/basic-call) — runnable code examples

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
