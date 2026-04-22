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

### Multi-agent orchestration

```ts
import { orchestrate } from '@flint/landlord';
import { fileTool, bashTool } from '@flint/landlord/tools';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const result = await orchestrate(
  'Build a CLI tool that fetches exchange rates and converts currencies',
  (workDir) => [fileTool(workDir), bashTool(workDir)],
  { adapter, landlordModel: 'claude-opus-4-7', tenantModel: 'claude-sonnet-4-6' },
);

if (result.ok) {
  console.log(result.value.status); // "complete"
  console.log(result.value.artifacts); // per-role output artifacts
}
```

## What you get

### Core (`flint`)

- 1 runtime dependency (`@standard-schema/spec`)
- 7 primitives: `call`, `stream`, `validate`, `tool`, `execute`, `count`, `agent`
- `agent()` loop with step / token / dollar budget caps
- 6 compress transforms + `pipeline()` combinator: `dedup`, `windowLast`, `windowFirst`, `truncateToolResults`, `summarize`, `orderForCache`
- 4 recipes: `react` (ReAct pattern), `retryValidate`, `reflect`, `summarize`
- RAG: chunk, store, retrieve
- Conversation memory with async summarization
- Safety: injection detection, redaction, permissions, approval gates, boundary wrapping

### Adapters (zero runtime dependencies each)

- `@flint/adapter-anthropic` — prompt-cache aware, pure `fetch` + `ReadableStream`
- `@flint/adapter-openai-compat` — any OpenAI-compatible endpoint (OpenAI, Groq, Ollama, DeepSeek, Together)

### Landlord (`@flint/landlord`)

Multi-agent orchestrator that decomposes a natural-language prompt into a dependency-ordered plan and runs each sub-task as an isolated tenant agent.

- `decompose()` — LLM-driven task decomposition into typed `Contract[]`
- `runTenant()` — single-tenant agent loop with Zod-validated checkpoints + LLM judge
- `orchestrate()` — topological sort, parallel dispatch, retry/eviction, shared artifact passing
- `tools/` subpath — `bashTool`, `fileTool`, `webTool` factory functions scoped to a working directory

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
| `@flint/landlord` | Multi-agent orchestrator: decompose, tenant agents, parallel dispatch |

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
