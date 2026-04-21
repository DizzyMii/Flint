# Flint Docs Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Flint logo to the repo, rewrite the README to professional grade, build a full VitePress docs site, and configure GitHub Pages auto-deployment.

**Architecture:** VitePress lives at `docs/` (existing directory). Internal design specs stay in `docs/superpowers/` and are excluded from navigation. The site deploys automatically to `https://dizzymii.github.io/flint/` via GitHub Actions on every push to `main`.

**Tech Stack:** VitePress ^1.6, pnpm workspaces, GitHub Actions, shields.io badges

---

## File Map

| Action | Path |
|---|---|
| Copy | `docs/public/logo.png` (from Downloads) |
| Create | `docs/.vitepress/config.ts` |
| Create | `docs/index.md` |
| Create | `docs/guide/index.md` |
| Create | `docs/guide/installation.md` |
| Create | `docs/guide/quick-start.md` |
| Create | `docs/guide/v0-status.md` |
| Create | `docs/primitives/call.md` |
| Create | `docs/primitives/stream.md` |
| Create | `docs/primitives/validate.md` |
| Create | `docs/primitives/tool.md` |
| Create | `docs/primitives/execute.md` |
| Create | `docs/primitives/count.md` |
| Create | `docs/primitives/agent.md` |
| Create | `docs/features/budget.md` |
| Create | `docs/features/compress.md` |
| Create | `docs/features/memory.md` |
| Create | `docs/features/rag.md` |
| Create | `docs/features/recipes.md` |
| Create | `docs/features/safety.md` |
| Create | `docs/features/graph.md` |
| Create | `docs/adapters/anthropic.md` |
| Create | `docs/adapters/openai-compat.md` |
| Create | `docs/adapters/custom.md` |
| Create | `docs/examples/basic-call.md` |
| Create | `docs/examples/tools.md` |
| Create | `docs/examples/agent.md` |
| Create | `docs/examples/streaming.md` |
| Create | `docs/examples/react-pattern.md` |
| Rewrite | `README.md` |
| Rewrite | `examples/README.md` |
| Create | `CONTRIBUTING.md` |
| Create | `.github/workflows/docs.yml` |
| Update | `package.json` |
| Update | `.gitignore` |

---

## Task 1: Infrastructure — logo, .gitignore, package.json, VitePress install

**Files:**
- Copy: `docs/public/logo.png`
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: Create docs/public directory**

```bash
mkdir -p docs/public
```

- [ ] **Step 2: Copy logo into repo**

```bash
cp "C:/Users/KadeHeglin/Downloads/Gemini_Generated_Image_szk0svszk0svszk0.png" docs/public/logo.png
```

Verify: `ls docs/public/` shows `logo.png`.

- [ ] **Step 3: Add VitePress to root devDependencies**

```bash
pnpm add -D -w vitepress
```

Expected: pnpm installs vitepress and updates `pnpm-lock.yaml`.

- [ ] **Step 4: Add docs scripts to root package.json**

Edit `package.json` scripts block — add three new entries:

```json
{
  "scripts": {
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "typecheck": "pnpm -r run typecheck",
    "lint": "biome check .",
    "format": "biome format --write .",
    "docs:dev": "vitepress dev docs",
    "docs:build": "vitepress build docs",
    "docs:preview": "vitepress preview docs",
    "changeset": "changeset",
    "release": "pnpm build && changeset publish"
  }
}
```

- [ ] **Step 5: Update .gitignore**

Append these lines to `.gitignore`:

```
docs/.vitepress/dist
docs/.vitepress/cache
.superpowers/
```

- [ ] **Step 6: Commit**

```bash
git add docs/public/logo.png package.json pnpm-lock.yaml .gitignore
git commit -m "chore: add logo, vitepress, docs scripts"
```

---

## Task 2: VitePress config

**Files:**
- Create: `docs/.vitepress/config.ts`

- [ ] **Step 1: Create the config directory**

```bash
mkdir -p docs/.vitepress
```

- [ ] **Step 2: Write `docs/.vitepress/config.ts`**

```typescript
import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Flint',
  description: 'Token-efficient agentic TypeScript runtime',
  base: '/flint/',

  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/flint/logo.png' }],
  ],

  themeConfig: {
    logo: '/logo.png',
    siteTitle: 'Flint',

    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'Primitives', link: '/primitives/call' },
      { text: 'Features', link: '/features/budget' },
      { text: 'Adapters', link: '/adapters/anthropic' },
      { text: 'Examples', link: '/examples/basic-call' },
      {
        text: 'v0',
        items: [
          { text: 'v0 Status & Stability', link: '/guide/v0-status' },
          { text: 'Changelog', link: 'https://github.com/DizzyMii/flint/blob/main/.changeset/README.md' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'What is Flint?', link: '/guide/' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Quick Start', link: '/guide/quick-start' },
            { text: 'v0 Status', link: '/guide/v0-status' },
          ],
        },
      ],
      '/primitives/': [
        {
          text: 'Primitives',
          items: [
            { text: 'call()', link: '/primitives/call' },
            { text: 'stream()', link: '/primitives/stream' },
            { text: 'validate()', link: '/primitives/validate' },
            { text: 'tool()', link: '/primitives/tool' },
            { text: 'execute()', link: '/primitives/execute' },
            { text: 'count()', link: '/primitives/count' },
            { text: 'agent()', link: '/primitives/agent' },
          ],
        },
      ],
      '/features/': [
        {
          text: 'Features',
          items: [
            { text: 'Budget', link: '/features/budget' },
            { text: 'Compress & Pipeline', link: '/features/compress' },
            { text: 'Memory', link: '/features/memory' },
            { text: 'RAG', link: '/features/rag' },
            { text: 'Recipes', link: '/features/recipes' },
            { text: 'Safety', link: '/features/safety' },
            { text: 'Graph', link: '/features/graph' },
          ],
        },
      ],
      '/adapters/': [
        {
          text: 'Adapters',
          items: [
            { text: 'Anthropic', link: '/adapters/anthropic' },
            { text: 'OpenAI-Compatible', link: '/adapters/openai-compat' },
            { text: 'Writing an Adapter', link: '/adapters/custom' },
          ],
        },
      ],
      '/examples/': [
        {
          text: 'Examples',
          items: [
            { text: 'Basic Call', link: '/examples/basic-call' },
            { text: 'Tool Use', link: '/examples/tools' },
            { text: 'Agent Loop', link: '/examples/agent' },
            { text: 'Streaming', link: '/examples/streaming' },
            { text: 'ReAct Pattern', link: '/examples/react-pattern' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/DizzyMii/flint' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 DizzyMii',
    },

    search: {
      provider: 'local',
    },

    editLink: {
      pattern: 'https://github.com/DizzyMii/flint/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
})
```

- [ ] **Step 3: Verify config parses**

```bash
pnpm docs:build 2>&1 | head -30
```

It will fail because content pages don't exist yet — that's fine. What should NOT appear: TypeScript parse errors in config.ts.

- [ ] **Step 4: Commit**

```bash
git add docs/.vitepress/config.ts
git commit -m "chore: add vitepress config"
```

---

## Task 3: Home page

**Files:**
- Create: `docs/index.md`

- [ ] **Step 1: Write `docs/index.md`**

```markdown
---
layout: home

hero:
  image:
    src: /logo.png
    alt: Flint
  name: Flint
  tagline: Token-efficient agentic TypeScript runtime
  text: Six primitives. One agent loop. No magic.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/
    - theme: alt
      text: View on GitHub
      link: https://github.com/DizzyMii/flint

features:
  - icon: ⚡
    title: Six composable primitives
    details: call, stream, validate, tool, execute, count — combine them yourself. No hidden orchestration.
  - icon: 🪙
    title: Budget-aware by default
    details: Hard caps on steps, tokens, and dollars. Every agent loop enforces them automatically.
  - icon: 🌊
    title: Streaming first
    details: Native AsyncIterable<StreamChunk> support. No callback soup, no buffering by default.
  - icon: 🔒
    title: Safety included
    details: Injection detection, output redaction, permission checks, and approval gates ship in core.
  - icon: 🔌
    title: Pluggable adapters
    details: Swap LLM providers without changing agent code. Anthropic and OpenAI-compatible adapters included.
  - icon: 🗺️
    title: State machine workflows
    details: The @flint/graph package adds typed state machine workflows with memory checkpointing.
---

<div style="text-align:center;margin:2rem 0;padding:1rem;background:var(--vp-c-bg-soft);border-radius:8px;border:1px solid var(--vp-c-warning-2)">
  <strong>v0 · under active development · not yet published to npm</strong><br>
  <span style="font-size:0.9em">API may change before 1.0. <a href="/flint/guide/v0-status">See stability notes.</a></span>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add docs/index.md
git commit -m "docs: add vitepress home page"
```

---

## Task 4: Guide section

**Files:**
- Create: `docs/guide/index.md`
- Create: `docs/guide/installation.md`
- Create: `docs/guide/quick-start.md`
- Create: `docs/guide/v0-status.md`

- [ ] **Step 1: Create guide directory**

```bash
mkdir -p docs/guide
```

- [ ] **Step 2: Write `docs/guide/index.md`**

```markdown
# What is Flint?

Flint is a token-efficient agentic TypeScript runtime. It gives you a minimal, composable set of typed building blocks for AI agents — and then stays out of the way.

## The core idea

Most AI agent frameworks abstract away the LLM interaction behind chains, classes, and hidden state. Flint inverts this: you get six plain functions and compose them yourself using ordinary TypeScript. The framework doesn't run your agent — JavaScript does.

```ts
import { call, tool, agent } from 'flint';
import { budget } from 'flint/budget';
import { anthropicAdapter } from '@flint/adapter-anthropic';
```

## What Flint is not

- **Not a RAG framework** — RAG utilities are included but minimal; bring your own vector database.
- **Not an orchestration platform** — no server, no deployment, no hosted runtime.
- **Not opinionated about prompt engineering** — Flint doesn't template your prompts.

## Packages

| Package | Role |
|---|---|
| `flint` | Core: primitives, agent loop, budget, compress, memory, RAG, recipes, safety |
| `@flint/adapter-anthropic` | Anthropic Messages API — prompt-cache aware |
| `@flint/adapter-openai-compat` | Any OpenAI-compatible endpoint |
| `@flint/graph` | State-machine agent workflows |

## Design principles

**One runtime dependency.** The `flint` core depends only on `@standard-schema/spec`. Adapters have zero runtime dependencies.

**Standard Schema for tool inputs.** Use Zod, Valibot, ArkType, or any Standard Schema-compatible library for tool input validation. Flint doesn't bundle a schema library.

**Results, not exceptions.** All public async functions return `Result<T>` — a discriminated union `{ ok: true; value: T } | { ok: false; error: Error }`. No try/catch at the call site.

**Web API primitives only.** Requires Node 20+ but uses only `fetch`, `ReadableStream`, and `TextDecoder` — works in edge runtimes.
```

- [ ] **Step 3: Write `docs/guide/installation.md`**

```markdown
# Installation

## Prerequisites

- **Node.js 20+** (Flint uses Web API primitives — `fetch`, `ReadableStream`, `TextDecoder`)
- A package manager: npm, pnpm, or yarn

## Install

Choose one adapter. The Anthropic adapter is the default; the OpenAI-compatible adapter works with any OpenAI-format endpoint.

::: code-group

```sh [Anthropic]
npm install flint @flint/adapter-anthropic
```

```sh [OpenAI-compatible]
npm install flint @flint/adapter-openai-compat
```

```sh [Both]
npm install flint @flint/adapter-anthropic @flint/adapter-openai-compat
```

:::

## Optional packages

```sh
# State machine workflows
npm install @flint/graph
```

## TypeScript configuration

Flint requires `"moduleResolution": "bundler"` or `"node16"/"nodenext"` to resolve subpath exports correctly.

```json
// tsconfig.json
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "target": "ES2022",
    "strict": true
  }
}
```

## Set up your API key

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

Or use a `.env` file with your preferred dotenv loader (Flint does not load `.env` automatically).

## Verify the install

```ts
import { call } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Say hello' }],
});

console.log(res.ok ? res.value.message.content : res.error.message);
```

> [!NOTE]
> Flint is not yet published to npm. Install from the repository directly during v0:
> `npm install github:DizzyMii/flint`
```

- [ ] **Step 4: Write `docs/guide/quick-start.md`**

```markdown
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

## Next steps

- [Primitives reference](/primitives/call) — full API for `call`, `stream`, `validate`, `tool`, `execute`, `count`
- [Agent loop & budget](/primitives/agent) — complete `agent()` options
- [Compress & pipeline](/features/compress) — reduce token usage with message transforms
- [Safety](/features/safety) — injection detection, redaction, approval gates
```

- [ ] **Step 5: Write `docs/guide/v0-status.md`**

```markdown
# v0 Status & API Stability

Flint is in **v0** — under active development and not yet published to npm. This page documents what that means for code you write against it.

## What v0 means

- The package is not on npm. Install from the GitHub repository.
- The public API may change without a major version bump before 1.0.
- Breaking changes will be documented in the changelog (`.changeset/`).
- There is no guaranteed deprecation window before 1.0.

## What is considered stable

These signatures are unlikely to change:

| Surface | Status |
|---|---|
| `call()`, `stream()`, `validate()`, `execute()`, `count()` | Stable |
| `tool()` type and factory | Stable |
| `agent()` core options (`adapter`, `model`, `messages`, `tools`, `budget`) | Stable |
| `ProviderAdapter` interface | Stable |
| `Result<T>` shape | Stable |
| `Message`, `Tool`, `Usage`, `StopReason` types | Stable |

## What may change

| Surface | Notes |
|---|---|
| `agent()` advanced options (`onStep`, `compress`, `maxSteps`) | Signatures may evolve |
| Compress transform signatures | `CompressCtx` may gain fields |
| Recipes API (`react`, `retryValidate`, `reflect`, `summarize`) | High-level API under iteration |
| `@flint/graph` DSL | State machine API actively being designed |
| Budget `consume()` / `remaining()` | Minor additions possible |
| Safety utilities | Signatures mostly stable; option sets may grow |

## How to protect yourself

**Pin your version:**
```sh
npm install github:DizzyMii/flint#abc1234
```

**Watch for breaking changes:**
The root `.changeset/README.md` and commit history document all breaking changes. The commit message prefix `feat!:` or `fix!:` signals a breaking change.

**Write integration tests.** Flint's primitives are easily testable with the built-in mock adapter (`flint/testing`).

## When will 1.0 land?

When the API surface is proven stable through real usage. There is no committed timeline.
```

- [ ] **Step 6: Commit**

```bash
git add docs/guide/
git commit -m "docs: add guide section (what is flint, install, quick start, v0 status)"
```

---

## Task 5: Primitives — call, stream, validate

**Files:**
- Create: `docs/primitives/call.md`
- Create: `docs/primitives/stream.md`
- Create: `docs/primitives/validate.md`

- [ ] **Step 1: Create primitives directory**

```bash
mkdir -p docs/primitives
```

- [ ] **Step 2: Write `docs/primitives/call.md`**

```markdown
# call()

Send a single request to an LLM and get a typed response.

`call()` is the lowest-level non-streaming request primitive. It applies optional compression, checks budget, calls the adapter, optionally validates the response against a schema, and returns a `Result`.

## Signature

```ts
function call<T = unknown>(options: CallOptions<T>): Promise<Result<CallOutput<T>>>
```

## CallOptions

```ts
type CallOptions<T = unknown> = {
  // Required
  adapter: ProviderAdapter;
  model: string;
  messages: Message[];

  // Optional — schema validation
  schema?: StandardSchemaV1<unknown, T>;

  // Optional — budget enforcement
  budget?: Budget;

  // Optional — message compression
  compress?: Transform;

  // Optional — pass-through to adapter
  tools?: Tool[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  cache?: boolean;

  // Optional — observability
  logger?: Logger;
  signal?: AbortSignal;
};
```

| Option | Type | Required | Description |
|---|---|---|---|
| `adapter` | `ProviderAdapter` | Yes | The LLM provider adapter |
| `model` | `string` | Yes | Model identifier (e.g. `'claude-opus-4-7'`) |
| `messages` | `Message[]` | Yes | Conversation history |
| `schema` | `StandardSchemaV1` | No | Validate response as JSON against this schema |
| `budget` | `Budget` | No | Enforce step/token/dollar limits |
| `compress` | `Transform` | No | Transform messages before sending |
| `tools` | `Tool[]` | No | Available tools for this call |
| `maxTokens` | `number` | No | Maximum response tokens |
| `temperature` | `number` | No | Sampling temperature |
| `stopSequences` | `string[]` | No | Stop generation at these sequences |
| `cache` | `boolean` | No | Enable prompt caching (adapter-specific) |
| `logger` | `Logger` | No | Debug/info/warn/error logger |
| `signal` | `AbortSignal` | No | Cancellation signal |

## CallOutput

```ts
type CallOutput<T = unknown> = {
  message: Message & { role: 'assistant' };
  value?: T;       // populated when schema is provided and response is valid JSON
  usage: Usage;
  cost?: number;
  stopReason: StopReason;
};
```

## Return value

`Promise<Result<CallOutput<T>>>` — never throws. On failure, returns `{ ok: false, error: Error }`.

Common error types:
- `AdapterError` — network or API error from the provider
- `BudgetExhausted` — budget limit hit before or after the call
- `ParseError` — response content was not valid JSON (when `schema` is set)
- `ValidationError` — response JSON did not match the schema

## Examples

### Basic call

```ts
import { call } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'What is 2 + 2?' }],
});

if (res.ok) {
  console.log(res.value.message.content); // "4"
  console.log(res.value.usage);           // { input: 12, output: 3 }
}
```

### With schema validation

```ts
import { call } from 'flint';
import * as v from 'valibot';

const SentimentSchema = v.object({
  label: v.picklist(['positive', 'negative', 'neutral']),
  score: v.number(),
});

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [
    { role: 'system', content: 'Respond with JSON only.' },
    { role: 'user', content: 'Sentiment of: "I love this library!"' },
  ],
  schema: SentimentSchema,
});

if (res.ok && res.value.value) {
  console.log(res.value.value.label); // "positive"
}
```

### With budget

```ts
import { call } from 'flint';
import { budget } from 'flint/budget';

const b = budget({ maxTokens: 1000, maxDollars: 0.05 });

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Hello' }],
  budget: b,
});
```

## See also

- [stream()](/primitives/stream) — streaming variant
- [agent()](/primitives/agent) — multi-step loop that calls `call()` internally
- [Budget](/features/budget) — budget limits and enforcement
- [Compress & Pipeline](/features/compress) — message transforms
```

- [ ] **Step 3: Write `docs/primitives/stream.md`**

```markdown
# stream()

Send a request to an LLM and receive chunks as they arrive via `AsyncIterable<StreamChunk>`.

`stream()` is the streaming counterpart to `call()`. It passes each chunk through as it arrives from the adapter, consuming budget on the `usage` chunk.

## Signature

```ts
function stream(options: StreamOptions): AsyncIterable<StreamChunk>
```

## StreamOptions

```ts
type StreamOptions = {
  // Required
  adapter: ProviderAdapter;
  model: string;
  messages: Message[];

  // Optional
  budget?: Budget;
  compress?: Transform;
  tools?: Tool[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  cache?: boolean;
  logger?: Logger;
  signal?: AbortSignal;
};
```

Same options as `call()` except `schema` is not available (parse the assembled text yourself after streaming).

## StreamChunk

```ts
type StreamChunk =
  | { type: 'text';     delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage';    usage: Usage; cost?: number }
  | { type: 'end';      reason: StopReason };
```

| Chunk type | When it appears | What to do |
|---|---|---|
| `text` | As text tokens arrive | Append `delta` to your buffer |
| `tool_call` | When the model calls a tool | Queue the call for execution |
| `usage` | Once, at end of response | Update budget, log telemetry |
| `end` | Final chunk | Check `reason` — `'end'`, `'tool_call'`, `'max_tokens'`, `'stop_sequence'` |

## Return value

`AsyncIterable<StreamChunk>` — iterate with `for await`. Throws `TypeError` if required options are missing.

## Example

```ts
import { stream } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

let text = '';

for await (const chunk of stream({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Write a haiku about TypeScript.' }],
})) {
  if (chunk.type === 'text') {
    process.stdout.write(chunk.delta);
    text += chunk.delta;
  }
  if (chunk.type === 'usage') {
    console.log('\nTokens:', chunk.usage);
  }
}
```

## See also

- [call()](/primitives/call) — non-streaming variant
- [agent()](/primitives/agent) — agent loop (uses `call()` internally, not `stream()`)
- [StreamChunk types](/primitives/stream) — full chunk type reference
```

- [ ] **Step 4: Write `docs/primitives/validate.md`**

```markdown
# validate()

Validate a value against a Standard Schema.

`validate()` is a thin async wrapper around the Standard Schema `~validate` protocol. It normalizes both sync and async schema libraries into a `Promise<Result<T>>`.

## Signature

```ts
function validate<T>(
  value: unknown,
  schema: StandardSchemaV1<unknown, T>
): Promise<Result<T>>
```

## Parameters

| Parameter | Type | Description |
|---|---|---|
| `value` | `unknown` | The value to validate |
| `schema` | `StandardSchemaV1<unknown, T>` | Any Standard Schema-compatible schema (Zod, Valibot, ArkType, etc.) |

## Return value

`Promise<Result<T>>` — `{ ok: true, value: T }` on success, `{ ok: false, error: ValidationError }` on failure.

## Example

```ts
import { validate } from 'flint';
import * as v from 'valibot';

const UserSchema = v.object({
  name: v.string(),
  age: v.number(),
});

const res = await validate({ name: 'Alice', age: 30 }, UserSchema);

if (res.ok) {
  console.log(res.value.name); // "Alice"
} else {
  console.error(res.error.message);
}
```

## Standard Schema compatibility

Works with any library that implements the Standard Schema spec:

- [Valibot](https://valibot.dev)
- [Zod](https://zod.dev)
- [ArkType](https://arktype.io)
- [TypeBox](https://github.com/sinclairzx81/typebox)

## See also

- [call()](/primitives/call) — `call()` uses `validate()` internally when `schema` is provided
- [Tool input validation](/primitives/tool) — tools use Standard Schema for input types
```

- [ ] **Step 5: Commit**

```bash
git add docs/primitives/call.md docs/primitives/stream.md docs/primitives/validate.md
git commit -m "docs: add primitives — call, stream, validate"
```

---

## Task 6: Primitives — tool, execute, count, agent

**Files:**
- Create: `docs/primitives/tool.md`
- Create: `docs/primitives/execute.md`
- Create: `docs/primitives/count.md`
- Create: `docs/primitives/agent.md`

- [ ] **Step 1: Write `docs/primitives/tool.md`**

```markdown
# tool()

Define a typed tool that an LLM can call.

`tool()` is an identity helper that infers types from your schema. It accepts a `Tool` spec and returns it unchanged — the value is in TypeScript inference.

## Signature

```ts
function tool<Input, Output>(spec: Tool<Input, Output>): Tool<Input, Output>
```

## Tool spec

```ts
type Tool<Input = unknown, Output = unknown> = {
  name: string;
  description: string;
  input: StandardSchemaV1<unknown, Input>;
  handler: (input: Input) => Promise<Output> | Output;
  permissions?: ToolPermissions;
  timeout?: number;
  jsonSchema?: Record<string, unknown>;
};

type ToolPermissions = {
  destructive?: boolean;
  scopes?: string[];
  network?: boolean;
  filesystem?: boolean;
  requireApproval?: boolean;
};
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Tool name (sent to the model) |
| `description` | `string` | Yes | What the tool does (sent to the model) |
| `input` | `StandardSchemaV1` | Yes | Validates and types the model's arguments |
| `handler` | `(input) => Output` | Yes | Executes the tool; may be async |
| `permissions` | `ToolPermissions` | No | Used by safety utilities |
| `timeout` | `number` | No | Milliseconds before handler is aborted |
| `jsonSchema` | `Record<string, unknown>` | No | Override JSON Schema sent to adapter (advanced) |

## Example

```ts
import { tool } from 'flint';
import * as v from 'valibot';

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  input: v.object({
    location: v.string(),
    unit: v.optional(v.picklist(['celsius', 'fahrenheit']), 'celsius'),
  }),
  handler: async ({ location, unit }) => {
    // fetch real weather here
    return { location, temperature: 22, unit };
  },
});
```

## See also

- [execute()](/primitives/execute) — run a tool directly (without an LLM)
- [agent()](/primitives/agent) — pass tools to the agent loop
- [Safety — permissioned tools](/features/safety) — enforce permissions at runtime
```

- [ ] **Step 2: Write `docs/primitives/execute.md`**

```markdown
# execute()

Execute a tool directly with type-safe argument handling.

`execute()` validates arguments against the tool's input schema, calls the handler, and wraps errors. It's what `agent()` calls internally for each tool call — but you can use it directly for testing or one-off tool invocations.

## Signature

```ts
function execute<Input, Output>(
  tool: Tool<Input, Output>,
  args: unknown
): Promise<Result<Output>>
```

## Parameters

| Parameter | Type | Description |
|---|---|---|
| `tool` | `Tool<Input, Output>` | The tool to execute |
| `args` | `unknown` | Raw arguments (typically parsed from the model's response) |

## Return value

`Promise<Result<Output>>` — `{ ok: true, value: Output }` on success. On failure: `{ ok: false, error: ToolError }` for handler exceptions, `{ ok: false, error: ValidationError }` for invalid arguments.

## Example

```ts
import { execute, tool } from 'flint';
import * as v from 'valibot';

const add = tool({
  name: 'add',
  description: 'Add two numbers',
  input: v.object({ a: v.number(), b: v.number() }),
  handler: ({ a, b }) => a + b,
});

const res = await execute(add, { a: 3, b: 4 });

if (res.ok) {
  console.log(res.value); // 7
}
```

## Testing tools

`execute()` makes it easy to unit test tools in isolation without an LLM:

```ts
import { describe, it, expect } from 'vitest';
import { execute } from 'flint';
import { myTool } from '../src/tools.ts';

describe('myTool', () => {
  it('handles valid input', async () => {
    const res = await execute(myTool, { value: 42 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(42);
  });

  it('rejects invalid input', async () => {
    const res = await execute(myTool, { value: 'not a number' });
    expect(res.ok).toBe(false);
  });
});
```

## See also

- [tool()](/primitives/tool) — define a tool
- [agent()](/primitives/agent) — agent loop calls `execute()` for each tool call
```

- [ ] **Step 3: Write `docs/primitives/count.md`**

```markdown
# count()

Count tokens in a message array.

`count()` delegates to the adapter's token counter when available, and falls back to `approxCount()` — a heuristic based on character length — when the adapter does not implement counting.

## Signature

```ts
function count(
  messages: Message[],
  model: string,
  adapter?: ProviderAdapter
): number
```

## Parameters

| Parameter | Type | Description |
|---|---|---|
| `messages` | `Message[]` | Messages to count |
| `model` | `string` | Model identifier (affects tokenization for some adapters) |
| `adapter` | `ProviderAdapter` | Optional — if provided, uses `adapter.count()` when available |

## Return value

`number` — estimated token count. When no adapter is provided, uses the built-in heuristic (`~chars / 4`).

## Example

```ts
import { count } from 'flint';

const messages = [
  { role: 'user' as const, content: 'What is the capital of France?' },
];

const tokens = count(messages, 'claude-opus-4-7');
console.log(tokens); // approximate count
```

## approxCount

When you only need a rough estimate without an adapter:

```ts
import { approxCount } from 'flint';

const n = approxCount(messages);
```

`approxCount` uses `chars / 4` as a heuristic. It is fast and has no dependencies, but is not accurate for all languages and models.

## See also

- [Budget](/features/budget) — enforce token limits
- [Compress & Pipeline](/features/compress) — reduce token count before sending
```

- [ ] **Step 4: Write `docs/primitives/agent.md`**

```markdown
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
```

- [ ] **Step 5: Commit**

```bash
git add docs/primitives/tool.md docs/primitives/execute.md docs/primitives/count.md docs/primitives/agent.md
git commit -m "docs: add primitives — tool, execute, count, agent"
```

---

## Task 7: Features — budget, compress

**Files:**
- Create: `docs/features/budget.md`
- Create: `docs/features/compress.md`

- [ ] **Step 1: Create features directory**

```bash
mkdir -p docs/features
```

- [ ] **Step 2: Write `docs/features/budget.md`**

```markdown
# Budget

Enforce hard limits on agent spend — steps, tokens, and dollars.

A `Budget` tracks usage across one or more `call()` or `agent()` calls and throws `BudgetExhausted` when a limit is hit.

## Creating a budget

```ts
import { budget } from 'flint/budget';

const b = budget({
  maxSteps: 10,       // max number of LLM calls
  maxTokens: 50_000,  // max total tokens (input + output + cached)
  maxDollars: 0.50,   // max spend in USD
});
```

At least one limit must be set. All limits are optional individually.

## BudgetLimits

```ts
type BudgetLimits = {
  maxSteps?: number;
  maxTokens?: number;
  maxDollars?: number;
};
```

## Budget interface

```ts
type Budget = {
  readonly limits: BudgetLimits;
  consume(x: ConsumeInput): void;
  assertNotExhausted(): void;
  remaining(): BudgetRemaining;
};

type ConsumeInput = Partial<Usage> & { cost?: number };

type BudgetRemaining = {
  steps?: number;
  tokens?: number;
  dollars?: number;
};
```

You rarely call `consume()` or `assertNotExhausted()` directly — `call()` and `agent()` do it for you. Use `remaining()` to inspect headroom.

## Checking remaining budget

```ts
const b = budget({ maxSteps: 5, maxDollars: 0.10 });

await agent({ ..., budget: b });

const rem = b.remaining();
console.log(`Steps left: ${rem.steps}`);    // 5 - steps used
console.log(`Dollars left: $${rem.dollars?.toFixed(4)}`);
```

## BudgetExhausted

When a limit is hit, `call()` or `agent()` returns `{ ok: false, error: BudgetExhausted }`.

```ts
import { BudgetExhausted } from 'flint/errors';

const res = await agent({ ..., budget: b });

if (!res.ok) {
  if (res.error instanceof BudgetExhausted) {
    console.log('Hit budget limit:', res.error.message);
  }
}
```

`BudgetExhausted.code` is one of `'budget.steps'`, `'budget.tokens'`, `'budget.dollars'`.

## Reusing a budget

A budget is stateful. To share a limit across multiple agent calls (e.g. total session cost):

```ts
const sessionBudget = budget({ maxDollars: 1.00 });

await agent({ ..., budget: sessionBudget });
await agent({ ..., budget: sessionBudget }); // continues depleting the same budget
```

## See also

- [agent()](/primitives/agent) — `budget` is required
- [call()](/primitives/call) — optional budget
- [Errors](/features/safety) — `BudgetExhausted` type
```

- [ ] **Step 3: Write `docs/features/compress.md`**

```markdown
# Compress & Pipeline

Reduce token count and shape message history before each LLM call.

A `Transform` is a function `(messages, ctx) => Promise<Message[]>`. Flint ships six built-in transforms. Combine them with `pipeline()`.

## Importing

```ts
import {
  pipeline,
  dedup,
  truncateToolResults,
  windowLast,
  windowFirst,
  summarize,
  orderForCache,
} from 'flint/compress';
```

## Transform type

```ts
type Transform = (messages: Message[], ctx: CompressCtx) => Promise<Message[]>;

type CompressCtx = {
  budget?: { remaining(): { tokens?: number } };
  model?: string;
};
```

## pipeline()

Compose transforms sequentially. Each transform receives the output of the previous one.

```ts
const compress = pipeline(
  dedup(),
  truncateToolResults({ maxChars: 2000 }),
  windowLast({ keep: 20 }),
);

const res = await call({ ..., compress });
```

## Built-in transforms

### dedup()

Remove consecutive duplicate messages (same role + content). System messages are always kept.

```ts
dedup(): Transform
```

### truncateToolResults(opts)

Truncate tool result messages that exceed `maxChars` characters.

```ts
truncateToolResults(opts: { maxChars: number }): Transform
```

`maxChars` must be > 50. Truncated messages get a suffix: `…[truncated, N chars dropped]`.

### windowLast(opts)

Keep only the last `keep` non-system messages, plus any messages matching `alwaysKeep` roles.

```ts
windowLast(opts: { keep: number; alwaysKeep?: Role[] }): Transform
```

### windowFirst(opts)

Keep only the first `keep` non-system messages, plus `alwaysKeep` roles.

```ts
windowFirst(opts: { keep: number; alwaysKeep?: Role[] }): Transform
```

### orderForCache()

Reorder messages to maximize prompt cache hit rate (system messages first, then history, then new user turn last). Use with prompt-cache-aware adapters.

```ts
orderForCache(): Transform
```

### summarize()

Summarize older messages to reduce history length. Requires a `call`-compatible context in `CompressCtx`. This is a stub in core — see [Recipes → summarize](/features/recipes) for a full implementation.

```ts
summarize(): Transform
```

## Example — full pipeline

```ts
import { pipeline, dedup, truncateToolResults, windowLast, orderForCache } from 'flint/compress';
import { agent } from 'flint';
import { budget } from 'flint/budget';

const compress = pipeline(
  dedup(),
  truncateToolResults({ maxChars: 4000 }),
  windowLast({ keep: 30, alwaysKeep: ['system'] }),
  orderForCache(),
);

const out = await agent({
  adapter,
  model: 'claude-opus-4-7',
  messages,
  tools,
  budget: budget({ maxSteps: 20, maxDollars: 1.00 }),
  compress,
});
```

## Writing a custom transform

```ts
import type { Transform } from 'flint/compress';

const redactSecrets: Transform = async (messages) => {
  return messages.map((msg) => ({
    ...msg,
    content: typeof msg.content === 'string'
      ? msg.content.replace(/sk-[a-z0-9]+/g, '[REDACTED]')
      : msg.content,
  }));
};
```

## See also

- [call()](/primitives/call) — accepts `compress` option
- [agent()](/primitives/agent) — applies compress before each step
- [Memory](/features/memory) — auto-summarizing conversation memory
- [Safety](/features/safety) — `redact()` for output redaction
```

- [ ] **Step 4: Commit**

```bash
git add docs/features/budget.md docs/features/compress.md
git commit -m "docs: add features — budget, compress"
```

---

## Task 8: Features — memory, rag

**Files:**
- Create: `docs/features/memory.md`
- Create: `docs/features/rag.md`

- [ ] **Step 1: Write `docs/features/memory.md`**

Read `packages/flint/src/memory.ts` for exact types. Then write `docs/features/memory.md`:

```markdown
# Memory

Manage conversation history and agent scratchpad state.

Flint's memory module provides two utilities: `messages()` for mutable message history and `conversationMemory()` for auto-summarizing long conversations.

## Importing

```ts
import { messages, scratchpad, conversationMemory } from 'flint/memory';
```

## messages()

A mutable message store.

```ts
const history = messages();

history.push({ role: 'user', content: 'Hello' });
history.push({ role: 'assistant', content: 'Hi!' });

console.log(history.all()); // all messages
history.clear();            // reset
```

## scratchpad()

A key-value note store for agent state that should not appear in the message history.

```ts
const pad = scratchpad();

pad.set('task', 'Write a blog post');
pad.get('task'); // 'Write a blog post'
pad.keys();      // ['task']
```

## conversationMemory()

Auto-summarizes old messages when the history exceeds a token threshold.

```ts
const mem = conversationMemory({
  adapter,
  model: 'claude-haiku-4-5-20251001',
  maxTokens: 4000,       // summarize when history exceeds this
  keepRecent: 10,        // always keep the last N messages
});

// Use mem.compress as the compress option in agent()
const out = await agent({
  adapter,
  model: 'claude-opus-4-7',
  messages: mem.messages(),
  compress: mem.compress,
  budget: budget({ maxSteps: 20 }),
});
```

## See also

- [Compress & Pipeline](/features/compress) — lower-level message transforms
- [RAG](/features/rag) — retrieval-augmented generation
- [Recipes → summarize](/features/recipes) — explicit summarization recipe
```

- [ ] **Step 2: Write `docs/features/rag.md`**

Read `packages/flint/src/rag.ts` for exact types. Then write `docs/features/rag.md`:

```markdown
# RAG

Retrieval-Augmented Generation utilities: chunking, in-memory vector store, and embedder interface.

## Importing

```ts
import { memoryStore, chunk } from 'flint/rag';
import type { Embedder, VectorStore } from 'flint/rag';
```

## memoryStore()

An in-memory vector store backed by cosine similarity search.

```ts
const store = memoryStore();

// Upsert documents
await store.upsert([
  { id: 'doc1', embedding: [0.1, 0.9, ...], content: 'TypeScript is great' },
]);

// Query
const results = await store.query({ embedding: queryEmbedding, topK: 5 });
// results: Array<{ id, content, score }>
```

## Embedder interface

Bring your own embeddings by implementing `Embedder`:

```ts
type Embedder = {
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
};
```

Example with OpenAI embeddings:

```ts
const embedder: Embedder = {
  embed: async (text) => {
    const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
    return res.data[0].embedding;
  },
};
```

## chunk()

Split long text into overlapping chunks for embedding.

```ts
const chunks = chunk(longText, { size: 500, overlap: 50 });
// chunks: string[]
```

## Full RAG pipeline example

```ts
import { memoryStore, chunk } from 'flint/rag';
import { call } from 'flint';

const store = memoryStore();
const embedder = myEmbedder;

// Index documents
for (const doc of documents) {
  const chunks = chunk(doc.text, { size: 500, overlap: 50 });
  for (const [i, text] of chunks.entries()) {
    const embedding = await embedder.embed(text);
    await store.upsert([{ id: `${doc.id}-${i}`, embedding, content: text }]);
  }
}

// Retrieve at query time
const queryEmbedding = await embedder.embed(userQuery);
const hits = await store.query({ embedding: queryEmbedding, topK: 3 });
const context = hits.map((h) => h.content).join('\n\n');

// Augment prompt
const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [
    { role: 'system', content: `Context:\n${context}` },
    { role: 'user', content: userQuery },
  ],
});
```

## See also

- [Memory](/features/memory) — conversation history management
- [call()](/primitives/call) — inject retrieved context into messages
```

- [ ] **Step 3: Commit**

```bash
git add docs/features/memory.md docs/features/rag.md
git commit -m "docs: add features — memory, rag"
```

---

## Task 9: Features — recipes, safety, graph

**Files:**
- Create: `docs/features/recipes.md`
- Create: `docs/features/safety.md`
- Create: `docs/features/graph.md`

- [ ] **Step 1: Write `docs/features/recipes.md`**

Read `packages/flint/src/recipes.ts` for exact signatures. Then write `docs/features/recipes.md`:

```markdown
# Recipes

High-level agent patterns built on `agent()` and `call()`.

## Importing

```ts
import { react, retryValidate, reflect, summarize } from 'flint/recipes';
```

## react()

ReAct (Reason + Act) agent pattern. The model reasons before each tool call, improving reliability on multi-step tasks.

```ts
const res = await react({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Research TypeScript 5.7 features' }],
  tools: [searchTool, readTool],
  budget: budget({ maxSteps: 10, maxDollars: 0.50 }),
});
```

## retryValidate()

Retry a `call()` with schema validation until the response parses correctly or a retry limit is hit.

```ts
import * as v from 'valibot';

const SummarySchema = v.object({ title: v.string(), points: v.array(v.string()) });

const res = await retryValidate({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Summarize this article: ...' }],
  schema: SummarySchema,
  maxRetries: 3,
});

if (res.ok && res.value.value) {
  console.log(res.value.value.title);
}
```

## reflect()

Ask the model to reflect on its previous response and improve it. Useful for multi-draft generation.

```ts
const res = await reflect({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Write a cover letter for...' }],
  rounds: 2,  // number of reflection rounds
  budget: budget({ maxSteps: 6 }),
});
```

## summarize()

Summarize a conversation or a long text using a lightweight model.

```ts
const summary = await summarize({
  adapter,
  model: 'claude-haiku-4-5-20251001',
  messages: longConversation,
});

if (summary.ok) {
  console.log(summary.value); // string summary
}
```

## See also

- [agent()](/primitives/agent) — recipes are built on top of `agent()`
- [Memory](/features/memory) — `conversationMemory()` uses the `summarize` recipe internally
```

- [ ] **Step 2: Write `docs/features/safety.md`**

Read `packages/flint/src/safety/` files for exact signatures. Then write `docs/features/safety.md`:

```markdown
# Safety

Prompt injection detection, output redaction, tool permission enforcement, and approval gates.

## Importing

```ts
import {
  detectPromptInjection,
  injectionPatterns,
  redact,
  secretPatterns,
  permissionedTools,
  requireApproval,
  boundary,
  untrusted,
} from 'flint/safety';
```

## detectPromptInjection()

Scan user input for prompt injection attempts before sending to the model.

```ts
const result = detectPromptInjection(userInput, { patterns: injectionPatterns });

if (result.detected) {
  console.warn('Injection attempt:', result.matches);
  return; // don't proceed
}
```

`injectionPatterns` is a built-in list of common injection phrases. Pass your own `patterns: RegExp[]` to extend or replace it.

## redact()

Remove sensitive content from LLM responses before returning to callers.

```ts
import { redact, secretPatterns } from 'flint/safety';

const safe = redact(response, { patterns: secretPatterns });
// API keys, secrets, PII patterns are replaced with [REDACTED]
```

## permissionedTools()

Wrap a tool array to enforce `ToolPermissions` at runtime. Tools marked `requireApproval: true` throw unless an approval function returns true.

```ts
import { permissionedTools } from 'flint/safety';

const safeTools = permissionedTools(tools, {
  allow: ({ tool }) => !tool.permissions?.destructive,
});
```

## requireApproval()

Gate tool execution behind a synchronous or async approval callback.

```ts
import { requireApproval } from 'flint/safety';

const approvedTools = requireApproval(tools, {
  approve: async ({ tool, args }) => {
    // Return true to allow, false to block
    return await askHuman(`Allow ${tool.name}(${JSON.stringify(args)})?`);
  },
});
```

## boundary() / untrusted()

Wrap a function with resource limits — timeout and error containment.

```ts
import { boundary } from 'flint/safety';

const safeFetch = boundary(fetch, { timeout: 5000 });
const res = await safeFetch('https://example.com');
```

`untrusted()` is an alias for `boundary()` with stricter defaults.

## See also

- [Tool permissions](/primitives/tool) — `ToolPermissions` type on tools
- [Compress & Pipeline](/features/compress) — `redact()` as a message transform
```

- [ ] **Step 3: Write `docs/features/graph.md`**

Read `packages/graph/src/index.ts` for exact API. Then write `docs/features/graph.md`:

```markdown
# Graph

State machine workflows with typed transitions and memory checkpointing.

`@flint/graph` is a separate package. Install it alongside `flint`:

```sh
npm install @flint/graph
```

## Importing

```ts
import { state, node, edge, graph, run, runStream } from '@flint/graph';
```

> [!WARNING] v0 API
> The graph DSL is actively being iterated on. Signatures may change before 1.0.

## Core concepts

A **graph** is a state machine: nodes do work (call an LLM, execute code, call an API), and edges define allowed transitions. The graph runs until it reaches a terminal node (a node with no outgoing edges).

## Defining a graph

```ts
import { state, node, edge, graph, run } from '@flint/graph';

type MyState = { query: string; result?: string };

const searchNode = node<MyState>(async (s, ctx) => {
  const res = await call({ adapter, model, messages: [{ role: 'user', content: s.query }] });
  return { ...s, result: res.ok ? res.value.message.content : undefined };
});

const g = graph<MyState>({
  nodes: { search: searchNode },
  edges: [
    edge('start', 'search'),
    edge('search', 'end'),
  ],
  initial: 'start',
  terminal: 'end',
});

const finalState = await run(g, { query: 'TypeScript 5.7 features' });
console.log(finalState.result);
```

## runStream()

Stream graph execution events as the state machine advances:

```ts
for await (const event of runStream(g, initialState)) {
  if (event.type === 'node:complete') {
    console.log(`Node ${event.node} done:`, event.state);
  }
}
```

## Memory checkpointing

```ts
import { memoryCheckpointStore } from '@flint/graph';

const store = memoryCheckpointStore();

const finalState = await run(g, initialState, { checkpointStore: store });

// Resume from checkpoint
const saved = await store.load('my-run-id');
```

## See also

- [agent()](/primitives/agent) — simpler looping without state machines
- [Recipes](/features/recipes) — higher-level patterns that don't need explicit graphs
```

- [ ] **Step 4: Commit**

```bash
git add docs/features/recipes.md docs/features/safety.md docs/features/graph.md
git commit -m "docs: add features — recipes, safety, graph"
```

---

## Task 10: Adapters section

**Files:**
- Create: `docs/adapters/anthropic.md`
- Create: `docs/adapters/openai-compat.md`
- Create: `docs/adapters/custom.md`

- [ ] **Step 1: Create adapters directory**

```bash
mkdir -p docs/adapters
```

- [ ] **Step 2: Write `docs/adapters/anthropic.md`**

Read `packages/adapter-anthropic/src/index.ts` for exact options. Then write:

```markdown
# Anthropic Adapter

Connect Flint to the Anthropic Messages API.

```sh
npm install @flint/adapter-anthropic
```

## Usage

```ts
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  // baseUrl?: string  — override for proxies
});
```

## Prompt caching

The Anthropic adapter is prompt-cache aware. Pass `cache: true` in `call()` or `agent()` options to enable ephemeral cache control blocks on system messages and tools:

```ts
const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Hello' }],
  cache: true,
});
```

Cache hits reduce input token costs by ~90% for cached content. See [Anthropic prompt caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) for eligibility rules.

## Capabilities

| Feature | Supported |
|---|---|
| Non-streaming (`call`) | Yes |
| Streaming (`stream`) | Yes |
| Tool use | Yes |
| Prompt caching | Yes |
| Token counting | Heuristic (`approxCount`) |
| Vision (image URLs) | Yes |
| Image base64 | Yes |

## Zero runtime dependencies

Uses only `fetch` and `ReadableStream` — no Anthropic SDK dependency.

## See also

- [OpenAI-Compatible adapter](/adapters/openai-compat)
- [Writing an adapter](/adapters/custom)
- [call() — cache option](/primitives/call)
```

- [ ] **Step 3: Write `docs/adapters/openai-compat.md`**

Read `packages/adapter-openai-compat/src/index.ts` for exact options. Then write:

```markdown
# OpenAI-Compatible Adapter

Connect Flint to any OpenAI-compatible API endpoint.

Works with: OpenAI, Groq, Together AI, DeepSeek, Ollama, and any provider that implements the OpenAI Chat Completions API format.

```sh
npm install @flint/adapter-openai-compat
```

## Usage

```ts
import { openaiCompatAdapter } from '@flint/adapter-openai-compat';

// OpenAI
const adapter = openaiCompatAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  baseUrl: 'https://api.openai.com/v1',
});

// Groq
const groqAdapter = openaiCompatAdapter({
  apiKey: process.env.GROQ_API_KEY!,
  baseUrl: 'https://api.groq.com/openai/v1',
});

// Ollama (local, no key needed)
const ollamaAdapter = openaiCompatAdapter({
  baseUrl: 'http://localhost:11434/v1',
});
```

## Capabilities

| Feature | Supported |
|---|---|
| Non-streaming (`call`) | Yes |
| Streaming (`stream`) | Yes |
| Tool use | Yes |
| Prompt caching | No (provider-specific) |
| Token counting | Heuristic (`approxCount`) |

## Zero runtime dependencies

Uses only `fetch` and `ReadableStream` — no OpenAI SDK dependency.

## See also

- [Anthropic adapter](/adapters/anthropic)
- [Writing an adapter](/adapters/custom)
```

- [ ] **Step 4: Write `docs/adapters/custom.md`**

Read `packages/flint/src/adapter.ts` for the full `ProviderAdapter` interface. Then write:

```markdown
# Writing an Adapter

Implement the `ProviderAdapter` interface to connect Flint to any LLM provider.

## ProviderAdapter interface

```ts
import type { ProviderAdapter, NormalizedRequest, NormalizedResponse } from 'flint';

type ProviderAdapter = {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  call(req: NormalizedRequest): Promise<NormalizedResponse>;
  stream(req: NormalizedRequest): AsyncIterable<StreamChunk>;
  count?(messages: Message[], model: string): number;
};

type AdapterCapabilities = {
  streaming: boolean;
  toolUse: boolean;
  promptCaching: boolean;
};
```

## Minimal implementation

```ts
import type { ProviderAdapter, NormalizedRequest, NormalizedResponse, StreamChunk } from 'flint';

export function myAdapter(opts: { apiKey: string }): ProviderAdapter {
  return {
    name: 'my-provider',
    capabilities: { streaming: true, toolUse: false, promptCaching: false },

    async call(req: NormalizedRequest): Promise<NormalizedResponse> {
      const resp = await fetch('https://api.myprovider.com/v1/chat', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(toProviderFormat(req)),
      });

      if (!resp.ok) throw new Error(`Provider error: ${resp.status}`);

      const data = await resp.json();
      return fromProviderFormat(data);
    },

    async *stream(req: NormalizedRequest): AsyncIterable<StreamChunk> {
      // implement SSE / ReadableStream parsing here
    },
  };
}
```

## NormalizedRequest and NormalizedResponse

Your adapter converts between these normalized types and the provider's wire format.

Read `packages/flint/src/adapter.ts` in the source for the full type definitions.

## Testing your adapter

Use Vitest and test `call()` and `stream()` with a real or mocked network:

```ts
import { call } from 'flint';
import { myAdapter } from './my-adapter.ts';

const adapter = myAdapter({ apiKey: 'test-key' });

const res = await call({
  adapter,
  model: 'my-model',
  messages: [{ role: 'user', content: 'Hello' }],
});

expect(res.ok).toBe(true);
```

## See also

- [Anthropic adapter source](https://github.com/DizzyMii/flint/tree/main/packages/adapter-anthropic/src)
- [OpenAI-compat adapter source](https://github.com/DizzyMii/flint/tree/main/packages/adapter-openai-compat/src)
```

- [ ] **Step 5: Commit**

```bash
git add docs/adapters/
git commit -m "docs: add adapters section — anthropic, openai-compat, custom"
```

---

## Task 11: Examples section

**Files:**
- Create: `docs/examples/basic-call.md`
- Create: `docs/examples/tools.md`
- Create: `docs/examples/agent.md`
- Create: `docs/examples/streaming.md`
- Create: `docs/examples/react-pattern.md`

- [ ] **Step 1: Create examples directory**

```bash
mkdir -p docs/examples
```

- [ ] **Step 2: Write `docs/examples/basic-call.md`**

```markdown
# Basic Call

Send a single message to an LLM and print the response.

```ts
import { call } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is the capital of France?' },
  ],
});

if (res.ok) {
  console.log(res.value.message.content);
  console.log('Usage:', res.value.usage);
  console.log('Stop reason:', res.value.stopReason);
} else {
  console.error('Error:', res.error.message);
}
```

## With schema validation

Parse and validate a structured JSON response:

```ts
import { call } from 'flint';
import * as v from 'valibot';

const CapitalSchema = v.object({
  city: v.string(),
  country: v.string(),
  population: v.number(),
});

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [
    { role: 'system', content: 'Respond with JSON only.' },
    { role: 'user', content: 'Capital of France as JSON' },
  ],
  schema: CapitalSchema,
});

if (res.ok && res.value.value) {
  const { city, country, population } = res.value.value;
  console.log(`${city}, ${country} — population: ${population}`);
}
```
```

- [ ] **Step 3: Write `docs/examples/tools.md`**

```markdown
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
```

- [ ] **Step 4: Write `docs/examples/agent.md`**

```markdown
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
```

- [ ] **Step 5: Write `docs/examples/streaming.md`**

```markdown
# Streaming

Receive tokens as they arrive using `AsyncIterable<StreamChunk>`.

```ts
import { stream } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import { budget } from 'flint/budget';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const b = budget({ maxTokens: 2000 });
let fullText = '';

process.stdout.write('Response: ');

for await (const chunk of stream({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Explain async iterators in TypeScript in three paragraphs.' }],
  budget: b,
})) {
  switch (chunk.type) {
    case 'text':
      process.stdout.write(chunk.delta);
      fullText += chunk.delta;
      break;
    case 'usage':
      // Budget is consumed automatically
      console.log(`\nTokens: input=${chunk.usage.input}, output=${chunk.usage.output}`);
      if (chunk.cost !== undefined) {
        console.log(`Cost: $${chunk.cost.toFixed(6)}`);
      }
      break;
    case 'end':
      console.log(`\nStop reason: ${chunk.reason}`);
      break;
  }
}

console.log(`\nBudget remaining: ${b.remaining().tokens} tokens`);
```
```

- [ ] **Step 6: Write `docs/examples/react-pattern.md`**

```markdown
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

- [agent()](/primitives/agent) — unstructured agent loop
- [Recipes](/features/recipes) — other recipe patterns
```

- [ ] **Step 7: Commit**

```bash
git add docs/examples/
git commit -m "docs: add examples section"
```

---

## Task 12: README rewrite

**Files:**
- Rewrite: `README.md`

- [ ] **Step 1: Write the new `README.md`**

Replace the entire file with:

```markdown
<p align="center">
  <img src="docs/public/logo.png" width="200" alt="Flint" />
</p>

<h1 align="center">flint</h1>

<p align="center">Token-efficient agentic TypeScript runtime</p>

<p align="center">
  <a href="https://img.shields.io/badge/version-v0-orange"><img src="https://img.shields.io/badge/version-v0-orange" alt="v0"></a>
  <a href="https://img.shields.io/badge/license-MIT-blue"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
  <a href="https://img.shields.io/badge/node-%E2%89%A520-brightgreen"><img src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen" alt="node ≥20"></a>
  <a href="https://img.shields.io/badge/TypeScript-5.7-blue"><img src="https://img.shields.io/badge/TypeScript-5.7-blue" alt="TypeScript"></a>
</p>

<p align="center">
  <a href="https://dizzymii.github.io/flint">Docs</a> ·
  <a href="https://dizzymii.github.io/flint/primitives/call">API Reference</a> ·
  <a href="https://dizzymii.github.io/flint/examples/basic-call">Examples</a>
</p>

---

> **v0 · under development · not yet published to npm**

Six primitives. One agent loop. No magic. **Flint** gives you well-typed building blocks for AI agents in TypeScript — and stays out of the way. JavaScript is the runtime; Flint gives you the tools.

## Install

```sh
npm install flint @flint/adapter-anthropic
```

> Not on npm yet. Install from the repo during v0:
> `npm install github:DizzyMii/flint`

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

- [Guide](https://dizzymii.github.io/flint/guide/) — installation, quick start, v0 stability notes
- [Primitives](https://dizzymii.github.io/flint/primitives/call) — `call`, `stream`, `validate`, `tool`, `execute`, `count`, `agent`
- [Features](https://dizzymii.github.io/flint/features/budget) — budget, compress, memory, RAG, recipes, safety, graph
- [Adapters](https://dizzymii.github.io/flint/adapters/anthropic) — Anthropic, OpenAI-compatible, custom
- [Examples](https://dizzymii.github.io/flint/examples/basic-call) — runnable code examples

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README with logo, badges, and full structure"
```

---

## Task 13: CONTRIBUTING.md and examples/README.md

**Files:**
- Create: `CONTRIBUTING.md`
- Rewrite: `examples/README.md`

- [ ] **Step 1: Write `CONTRIBUTING.md`**

```markdown
# Contributing to Flint

Flint is in v0 and the codebase is actively evolving. Contributions are welcome.

## Setup

```sh
git clone https://github.com/DizzyMii/flint.git
cd flint
pnpm install
```

## Build

```sh
pnpm build          # build all packages
pnpm typecheck      # TypeScript type check
pnpm lint           # Biome lint
pnpm format         # Biome format (writes)
```

## Test

```sh
pnpm test           # run all tests (vitest)
```

Tests live in `packages/<name>/test/`. Flint uses real integration-style tests where possible — the mock adapter in `flint/testing` makes this straightforward without an actual API key.

## Docs

```sh
pnpm docs:dev       # start VitePress dev server at localhost:5173
pnpm docs:build     # build static site to docs/.vitepress/dist
pnpm docs:preview   # preview the built site
```

Documentation lives in `docs/`. All pages are Markdown.

## Submitting changes

1. Fork the repo and create a branch: `git checkout -b feat/my-change`
2. Make your changes with tests
3. Run `pnpm test && pnpm typecheck && pnpm lint`
4. Open a pull request against `main`

For breaking changes or new packages, open an issue first to discuss.

## Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) for versioning.

```sh
pnpm changeset      # describe your change
```

A changeset file is required for any change that affects a published package's behavior.
```

- [ ] **Step 2: Write `examples/README.md`**

```markdown
# Examples

Runnable code examples for Flint. Full annotated examples live in the [documentation](https://dizzymii.github.io/flint/examples/basic-call).

## Quick reference

| Example | Description |
|---|---|
| [Basic call](https://dizzymii.github.io/flint/examples/basic-call) | One-shot `call()` with and without schema validation |
| [Tool use](https://dizzymii.github.io/flint/examples/tools) | Define tools; inspect tool calls in the response |
| [Agent loop](https://dizzymii.github.io/flint/examples/agent) | Multi-step `agent()` with `onStep` callback |
| [Streaming](https://dizzymii.github.io/flint/examples/streaming) | `stream()` with chunk handling and budget tracking |
| [ReAct pattern](https://dizzymii.github.io/flint/examples/react-pattern) | `react()` recipe for structured reasoning |

## Running locally

```sh
pnpm install
ANTHROPIC_API_KEY=sk-ant-... node examples/basic-call.ts
```

Runnable `.ts` files will be added to this directory as the library stabilizes past v0.
```

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md examples/README.md
git commit -m "docs: add CONTRIBUTING.md and update examples/README.md"
```

---

## Task 14: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/docs.yml`

- [ ] **Step 1: Create GitHub Actions directory**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: Write `.github/workflows/docs.yml`**

```yaml
name: Deploy docs

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v3
        with:
          version: 9

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: pnpm

      - name: Install dependencies
        run: pnpm install

      - name: Build docs
        run: pnpm docs:build

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: docs/.vitepress/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/docs.yml
git commit -m "ci: add github actions docs deploy workflow"
```

- [ ] **Step 4: Enable GitHub Pages**

In the GitHub repo: **Settings → Pages → Source → GitHub Actions**. This must be done manually in the browser — the workflow will fail if Pages source is still set to "Branch".

---

## Task 15: Build verification

- [ ] **Step 1: Run full VitePress build**

```bash
pnpm docs:build 2>&1
```

Expected: `✓ building client + server bundles...` and `✓ rendering pages...` with no errors. A list of pages built should appear.

If there are broken links or missing files, VitePress will warn. Fix any broken internal links in the relevant markdown files.

- [ ] **Step 2: Check for broken sidebar links**

VitePress warns about pages referenced in the sidebar but not found. Compare the sidebar in `docs/.vitepress/config.ts` against files that exist on disk. Every sidebar entry must have a corresponding `.md` file.

- [ ] **Step 3: Preview the built site**

```bash
pnpm docs:preview
```

Open `http://localhost:4173/flint/` in a browser. Verify:
- Logo appears in the navbar
- Home page hero renders correctly
- All sidebar sections expand and link to the right pages
- v0 warning banner appears on home page
- Code blocks render with syntax highlighting

- [ ] **Step 4: Final commit**

```bash
git add -A
git status   # confirm only expected files are staged
git commit -m "docs: complete docs overhaul — vitepress, readme, examples, contributing"
```
