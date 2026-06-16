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

Six primitives. One agent loop. No magic. **Flint** gives you well-typed building blocks for AI agents in TypeScript and stays out of the way — plain async functions over the provider API, one runtime dependency, errors returned as values instead of thrown.

## Install

```sh
npm install flint @flint/adapter-anthropic
```

ESM only, Node 20+, `strict: true`. The Anthropic adapter reads `ANTHROPIC_API_KEY` from the environment. See the [setup guide](https://dizzymii.github.io/Flint/guide/) for tsconfig and `.env` details.

## Quick start

```ts
import { call, tool, agent } from 'flint';
import { budget } from 'flint/budget';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import * as v from 'valibot'; // any Standard Schema library works

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

// One-shot call — errors come back as values, nothing throws
const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});
if (res.ok) console.log(res.value.message.content); // "Paris"

// A tool
const add = tool({
  name: 'add',
  description: 'Add two numbers',
  input: v.object({ a: v.number(), b: v.number() }),
  handler: ({ a, b }) => a + b,
});

// Agent loop with enforced step / token / dollar caps
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

**Core (`flint`)** — 1 runtime dependency (`@standard-schema/spec`)

- 6 primitives: `call`, `stream`, `validate`, `tool`, `execute`, `count`
- `agent()` loop with step / token / dollar budget caps
- compress transforms + `pipeline()`: `dedup`, `windowLast`, `windowFirst`, `truncateToolResults`, `summarize`, `orderForCache`
- recipes: `react`, `retryValidate`, `reflect`, `summarize`
- RAG (chunk, store, retrieve), conversation memory with async summarization
- safety: injection detection, redaction, permissions, approval gates, boundary wrapping

## Packages

| Package | Description |
|---|---|
| `flint` | Core primitives, agent loop, compress, memory, RAG, safety, recipes |
| `@flint/adapter-anthropic` | Anthropic Messages API — prompt-cache aware |
| `@flint/adapter-openai-compat` | Any OpenAI-compatible endpoint (OpenAI, Groq, Ollama, DeepSeek, Together) |
| `@flint/graph` | State-machine agent workflows with memory checkpointing |
| `@flint/landlord` | Multi-agent orchestration — dynamic workflow runtime and auto-decompose `orchestrate()` |

Adapters and graph each ship with zero runtime dependencies, on Web API primitives only (`fetch`, `ReadableStream`, `TextDecoder`).

## Why Flint

- **One dependency** — `@standard-schema/spec` only. No transitive framework sprawl.
- **No classes, no chains** — plain functions that compose naturally.
- **Standard Schema** — bring Zod, Valibot, ArkType, or any compatible library.
- **Budget-aware** — every agent loop enforces step, token, and dollar limits.
- **Streaming first** — `AsyncIterable<StreamChunk>` throughout.
- **Safety in core** — injection detection, redaction, and approval gates, not an afterthought.
- **Results, not exceptions** — `Promise<Result<T>>` everywhere; no try/catch at the call site.

Coming from LangChain? See the [Flint vs LangChain](https://dizzymii.github.io/Flint/guide/vs-langchain) guide for a full side-by-side.

## Documentation

Full docs at **[dizzymii.github.io/Flint](https://dizzymii.github.io/Flint)** — [primitives](https://dizzymii.github.io/Flint/primitives/call), [features](https://dizzymii.github.io/Flint/features/budget), [adapters](https://dizzymii.github.io/Flint/adapters/anthropic), [examples](https://dizzymii.github.io/Flint/examples/basic-call), [landlord](https://dizzymii.github.io/Flint/landlord/), [testing](https://dizzymii.github.io/Flint/guide/testing), and [FAQ](https://dizzymii.github.io/Flint/guide/faq).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
