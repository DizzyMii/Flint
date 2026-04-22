# Flint Docs Expansion — Design Spec

**Date:** 2026-04-22
**Status:** Approved
**Goal:** Comprehensive documentation that explains everything anyone could want to know about Flint — intuitive, complete, nothing left to wonder about.

---

## Scope Overview

8 workstreams, all independent and parallelisable:

| # | Workstream | New Files | Modified Files |
|---|-----------|-----------|----------------|
| 1 | Flint vs LangChain page | `docs/guide/vs-langchain.md` | `README.md`, `config.ts` |
| 2 | README setup section | — | `README.md` |
| 3 | FAQ page | `docs/guide/faq.md` | `config.ts` |
| 4 | Landlord docs | 6 new under `docs/landlord/` | `config.ts` |
| 5 | Testing guide | `docs/guide/testing.md` | `config.ts` |
| 6 | Error reference | `docs/reference/errors.md` | `config.ts` |
| 7 | Depth pass | — | All 25 existing doc pages |
| 8 | New examples | 5 new under `docs/examples/` | `config.ts` |

---

## Workstream 1: Flint vs LangChain Page

**File:** `docs/guide/vs-langchain.md`

### Purpose
A narrative deep-dive for developers who know LangChain and want to understand the difference in depth. Not a marketing page — a genuine technical comparison.

### Sections

**Philosophy**
LangChain models the AI stack as composable objects: `LLM`, `Chain`, `AgentExecutor`, `Tool`. Everything is a class instance you wire together. Flint models it as composable functions: `call()`, `tool()`, `agent()`. There is no framework to learn — TypeScript is the glue. The tradeoff: LangChain's abstractions unlock ecosystem integrations quickly; Flint's functions are easier to test, debug, and reason about.

**Dependency model**
LangChain requires 3+ packages for a minimal Anthropic agent (`langchain`, `@langchain/anthropic`, `@langchain/core`), each with their own transitive dependency trees. Flint requires two packages (`flint`, `@flint/adapter-anthropic`) with one runtime dependency total (`@standard-schema/spec`). Show a `node_modules` count comparison if available.

**Error handling**
LangChain surfaces errors via thrown exceptions at `executor.invoke()`. Flint returns `Result<T>` everywhere — `{ ok: true, value }` or `{ ok: false, error }`. No try/catch at call sites. Show side-by-side: LangChain try/catch vs Flint `if (!res.ok)`.

**Schema / validation**
LangChain tools are Zod-only. Flint uses Standard Schema — any compatible library (Zod, Valibot, ArkType, Effect Schema). Show the same tool defined with Zod and with Valibot.

**Streaming**
LangChain streams via callbacks or `streamEvents()`. Flint streams via `AsyncIterable<StreamChunk>` — native `for await` loops, no callbacks. Show side-by-side.

**Budget and safety**
LangChain has no built-in token/dollar budget enforcement. Flint's `agent()` loop enforces hard caps (`maxSteps`, `maxTokens`, `maxDollars`). Safety (injection detection, redaction, approval gates) ships in core.

**Prompt caching**
The Anthropic adapter in Flint is prompt-cache aware by default. LangChain supports caching but requires explicit configuration. Show how Flint handles it transparently.

**When to choose LangChain**
- You need ecosystem integrations (dozens of vector stores, document loaders, etc.)
- Your team already knows LangChain
- You want LCEL chain composition

**When to choose Flint**
- You want minimal dependencies and full control
- You prefer functional composition over class hierarchies
- You need hard budget enforcement
- You want `Result<T>` instead of exceptions
- You're building production agents that need safety primitives in core

### README update
The existing `## Flint vs LangChain` section in README.md gets a link added at the bottom:
```markdown
> For a full narrated comparison including streaming, schema, caching, and when to choose each — see [Flint vs LangChain](/guide/vs-langchain) in the docs.
```

### VitePress config
Add to Guide sidebar:
```ts
{ text: 'Flint vs LangChain', link: '/guide/vs-langchain' }
```

---

## Workstream 2: README Setup Section

**File:** `README.md`

### New section: `## Setup`

Inserted between `## Install` and `## Quick start`. Covers:

1. **API key** — set `ANTHROPIC_API_KEY` in `.env` or shell; show `dotenv` snippet and `process.env` usage
2. **TypeScript config** — requires `"moduleResolution": "bundler"` or `"node16"` and `"strict": true`; show minimal `tsconfig.json`
3. **ESM** — Flint is ESM-only; `"type": "module"` required in `package.json`
4. **Verification** — a 3-line snippet that confirms the setup works (basic call returning "Paris")

---

## Workstream 3: FAQ Page

**File:** `docs/guide/faq.md`

### VitePress config
Add to Guide sidebar:
```ts
{ text: 'FAQ', link: '/guide/faq' }
```

### Questions (all answered in full, no "see X" redirects)

**Architecture & design decisions**
- Why plain functions instead of classes? — Testability, composability, no `this` binding issues, easier to tree-shake, easier to read call stacks.
- Why `Result<T>` instead of throwing? — Thrown errors are invisible in type signatures. `Result<T>` makes failure a first-class part of the API contract. You can't accidentally forget to handle an error.
- Why Standard Schema instead of Zod? — Zod is one library; Standard Schema is a spec. Code that accepts `StandardSchemaV1` works with Zod, Valibot, ArkType, Effect Schema, and anything else that implements the spec. You're not locked to a validator.
- Why ESM only? — Tree-shaking, top-level await, native `import.meta`, consistent module semantics. CJS interop is handled by the consumer's bundler.
- Why are there so few dependencies? — Each dependency is a maintenance burden, a supply-chain risk, and a version-conflict surface. `@standard-schema/spec` is a zero-dependency spec package.

**RAG & vector search**
- How does Flint handle RAG? — `chunk()` splits documents, `memoryStore()` stores embeddings, `retrieve()` does cosine similarity search. Show the full 3-step flow with code.
- Does Flint include a vector database? — No. `memoryStore()` is an in-memory store for simple cases. For production, wrap a vector DB (Pinecone, Weaviate, pgvector) behind the `EmbeddingStore` interface.
- What embedding model should I use? — Any model that returns `number[]` per chunk. Show OpenAI `text-embedding-3-small` example and a local model example.
- How do I plug in my own vector store? — Implement the `EmbeddingStore` interface (two methods: `add`, `query`). Show a minimal implementation.

**Agents & budget**
- How is budget enforced? — Before each step, `agent()` checks remaining steps/tokens/dollars. If any cap is hit, the loop exits with `stopReason: 'budget'`. Budget is shared across all steps.
- What happens when budget is exhausted mid-stream? — The stream is terminated cleanly; the agent returns `{ ok: true, value: { stopReason: 'budget', ... } }`. No error thrown.
- Can I reuse a budget across multiple agent calls? — Yes. Pass the same `budget` instance to multiple calls. It tracks cumulative usage. Useful for enforcing a per-session dollar cap across many agent invocations.
- How do I handle tool errors? — Tools return `Result<T>`. If a tool handler throws, `execute()` catches it and wraps it in `{ ok: false, error }`. The agent sees a tool error message and can decide to retry or stop.

**Providers & adapters**
- Can I use multiple providers in the same app? — Yes. Create multiple adapter instances. Pass whichever adapter you want to each `call()` / `agent()` invocation.
- Does Flint support local models? — Yes, via `@flint/adapter-openai-compat` pointed at a local Ollama endpoint.
- How does prompt caching work? — The Anthropic adapter automatically adds cache-control breakpoints at system prompt boundaries. You don't configure it; it just works. See the Anthropic adapter docs for details.
- Can I write my own adapter? — Yes. Implement `ProviderAdapter` (3 methods: `call`, `stream`, optional `count`). See [Writing an Adapter](/adapters/custom).

**Safety**
- What is prompt injection detection? — `detectInjection()` scans tool results and user messages for patterns that attempt to override system instructions. Returns a risk score and matched patterns.
- What is a trust boundary? — `trustBoundary()` wraps an adapter and automatically runs injection detection on every response before it reaches your agent. If injection is detected above a threshold, the message is blocked.
- How does redaction work? — `redact()` strips secrets (API keys, emails, SSNs, credit cards) from messages before they're sent to the LLM.

**Streaming**
- Why AsyncIterable instead of callbacks? — `for await` is easier to reason about, composes with standard async patterns, works with `AbortController`, and doesn't require managing listener lifecycle.
- How do I cancel a stream? — Pass an `AbortSignal` to `stream()`. Abort the associated `AbortController` to cancel.

**Graph**
- When should I use `@flint/graph` vs `agent()`? — Use `agent()` for open-ended tasks where the number of steps is unknown. Use `@flint/graph` for workflows with known structure, conditional branching, fan-out, and checkpointing requirements.

---

## Workstream 4: Landlord Docs

**New section: `docs/landlord/`** (6 pages)

The landlord package is an orchestration layer that uses Flint agents as isolated "tenants" working in parallel toward a shared goal.

### VitePress config — new sidebar section
```ts
'/landlord/': [
  {
    text: 'Landlord',
    items: [
      { text: 'What is Landlord?', link: '/landlord/' },
      { text: 'Contracts', link: '/landlord/contract' },
      { text: 'decompose()', link: '/landlord/decompose' },
      { text: 'orchestrate()', link: '/landlord/orchestrate' },
      { text: 'runTenant()', link: '/landlord/tenant' },
      { text: 'Standard Tools', link: '/landlord/tools' },
    ],
  },
],
```

Add to top nav:
```ts
{ text: 'Landlord', link: '/landlord/' }
```

### Page: `docs/landlord/index.md` — What is Landlord?

**Content:**
- Mental model: "landlord" decomposes a high-level goal into a set of isolated "tenant" agents. Each tenant has a `Contract` (role, objective, checkpoints, output schema). Tenants run in parallel where dependencies allow; dependencies gate execution.
- Key concepts: Contract, Checkpoint, Tenant, Orchestrator, Artifact, Eviction/Escalation
- Full quick-start example: `orchestrate("Build me a REST API for a todo app", standardTools, config)` showing the 30-line setup including adapter, model, budget, onEvent handler
- Architecture diagram (text/ASCII): `prompt → decompose() → [Contract[]] → resolveOrder() → parallel runTenant() → OrchestrateResult`
- When to use landlord vs a single agent loop

### Page: `docs/landlord/contract.md` — Contracts

**Content:**
- What a Contract is: the specification given to a tenant before it runs
- Full `ContractSchema` field reference:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `tenantId` | `string` | — | `crypto.randomUUID().slice(0,8)` | Unique identifier |
| `role` | `string` | ✓ | — | Human-readable role name, used as dependency key |
| `objective` | `string` | ✓ | — | High-level goal for this tenant |
| `subPrompt` | `string` | ✓ | — | Detailed instructions injected into the tenant's system prompt |
| `checkpoints` | `Checkpoint[]` | ✓ | — | Ordered milestones the tenant must hit |
| `outputSchema` | `Record<string, unknown>` | ✓ | — | JSON Schema for the tenant's final artifact |
| `toolsAllowed` | `string[]` | — | all | Allowlist of tool names |
| `toolsDenied` | `string[]` | — | none | Denylist of tool names |
| `dependsOn` | `string[]` | — | `[]` | Roles that must complete before this tenant starts |
| `maxRetries` | `number` | — | `3` | Max eviction+retry cycles before escalation |

- `Checkpoint` schema: `{ name, description, schema }` — `schema` is a JSON Schema the tenant's artifact must satisfy at that checkpoint
- How `decompose()` produces contracts automatically vs constructing them manually
- Example: manual contract construction for a 2-tenant pipeline

### Page: `docs/landlord/decompose.md` — decompose()

**Content:**
- What it does: calls the LLM with a structured tool (`emit_plan`) to produce a `Contract[]` from a free-form goal string
- Signature:
```ts
function decompose(
  prompt: string,
  config: {
    adapter: ProviderAdapter;
    model: string;
    budget?: Budget;
  }
): Promise<Result<Contract[]>>
```
- How it works internally: calls `call()` with a system prompt and forces `emit_plan` tool use; validates each contract against `ContractSchema`; returns `{ ok: false }` for malformed contracts
- Tips for writing good decompose prompts (specificity, scope, naming roles clearly)
- Example: decompose a software project goal, print the resulting contracts
- What to do if decompose returns unexpected contracts (manual override pattern)

### Page: `docs/landlord/orchestrate.md` — orchestrate()

**Content:**
- What it does: runs the full orchestration pipeline — decompose, topological sort, parallel tenant dispatch, retry/eviction, artifact collection
- Signature:
```ts
function orchestrate(
  prompt: string,
  toolsFactory: (workDir: string) => Tool[],
  config: OrchestratorConfig
): Promise<Result<OrchestrateResult>>
```
- `OrchestratorConfig` full field reference:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adapter` | `ProviderAdapter` | ✓ | Adapter for both landlord and tenant calls |
| `landlordModel` | `string` | ✓ | Model used for decompose() |
| `tenantModel` | `string` | ✓ | Model used for each runTenant() |
| `budget` | `Budget` | — | Shared job-level budget across all calls |
| `outputDir` | `string` | — | Dir for tenant work dirs; defaults to OS tmpdir |
| `onEvent` | `(e: LandlordEvent) => void` | — | Progress callback |

- `LandlordEvent` type catalog with description of each event type
- `OrchestrateResult` structure: `{ status, tenants, artifacts }`
- Dependency resolution: how `resolveOrder()` performs DFS topological sort; `DependencyCycleError`
- Retry/eviction: on tenant failure, re-runs from scratch up to `maxRetries`; on exhaustion, marks tenant as `escalated`
- Artifact passing: completed tenant artifacts are injected into dependent tenants' context as `role.fieldName`
- Parallel execution: independent tenants run concurrently via `Promise.all`
- Full example with `onEvent` logging

### Page: `docs/landlord/tenant.md` — runTenant()

**Content:**
- What it does: runs a single agent loop for one tenant contract, producing a validated artifact
- Signature:
```ts
function runTenant(
  contract: Contract,
  tools: Tool[],
  config: {
    adapter: ProviderAdapter;
    model: string;
    budget?: Budget;
    workDir: string;
  },
  lastError?: string,
  sharedArtifacts?: Record<string, unknown>
): Promise<Result<Record<string, unknown>>>
```
- How the system prompt is constructed from `contract.role`, `objective`, `subPrompt`, checkpoints, outputSchema
- How `lastError` is injected when retrying after eviction
- How `sharedArtifacts` from dependencies are injected as context
- Checkpoint validation: after each step, `validateCheckpoint()` checks the agent's current output against the checkpoint schema; failure triggers eviction
- Tool filtering: `toolsAllowed`/`toolsDenied` from the contract are applied to the provided tools
- Output extraction: the agent's final message is parsed against `outputSchema`
- When to call `runTenant()` directly vs using `orchestrate()`

### Page: `docs/landlord/tools.md` — Standard Tools

**Content:**
- `standardTools(workDir: string): Tool[]` — returns the three built-in tools scoped to a work directory
- **`bashTool`** — executes shell commands inside `workDir`; sandboxed (commands are run with `workDir` as cwd); show example tool call and output
- **`fileReadTool`** — reads a file relative to `workDir`; path traversal guard (rejects `../` paths); show example
- **`fileWriteTool`** — writes/creates a file relative to `workDir`; creates parent dirs; show example
- **`webFetchTool`** — HTTP GET with response truncation for large pages; show example
- How to pass a subset of standard tools via `toolsAllowed`
- How to add custom tools alongside standard tools
- Security notes: bash sandbox, path traversal guard, web fetch timeout

---

## Workstream 5: Testing Guide

**File:** `docs/guide/testing.md`

### VitePress config
Add to Guide sidebar:
```ts
{ text: 'Testing', link: '/guide/testing' }
```

### Sections

**Why testing Flint code is easy**
No network calls in tests. `mockAdapter()` / `scriptedAdapter()` replace the LLM. Tools are plain functions — test them directly with `execute()`.

**mockAdapter()**
Full API docs:
- `onCall: (req, callIndex) => NormalizedResponse` — return a scripted response for any call
- `onStream: (req, callIndex) => AsyncIterable<StreamChunk>` — optional streaming override
- `count: (messages, model) => number` — optional token count override
- `adapter.calls: NormalizedRequest[]` — inspect what was sent to the LLM
- Show: testing that the right messages were sent, testing tool call parsing, testing multi-turn conversations

**scriptedAdapter()**
- Simpler API: pass an array of `NormalizedResponse` objects; each call consumes the next one
- Throws if more calls are made than responses provided
- Show: testing an agent loop that makes exactly 3 calls

**Testing tool handlers directly**
- `execute(tool, input)` runs the tool handler directly, no LLM needed
- Show: unit test for a calculator tool, a file tool, an API-calling tool with mocked fetch

**Testing budget enforcement**
- Pass a tight budget to `agent()`, verify it stops at the right step
- Show: test that `stopReason === 'budget'` when maxSteps is reached

**Integration testing pattern**
- Use `scriptedAdapter` with realistic responses for end-to-end flow tests
- Show: full agent loop test with tool use, multi-step, budget

**Testing safety primitives**
- `detectInjection()` is a pure function — test directly with malicious strings
- `redact()` is a pure function — test that secrets are stripped

---

## Workstream 6: Error Reference

**File:** `docs/reference/errors.md`

Create `docs/reference/` directory. Add to VitePress config as a new nav item or under Guide.

### VitePress config
Add new nav item:
```ts
{ text: 'Reference', link: '/reference/errors' }
```
Add sidebar:
```ts
'/reference/': [
  {
    text: 'Reference',
    items: [
      { text: 'Error Types', link: '/reference/errors' },
    ],
  },
],
```

### Content

All errors extend `FlintError extends Error` with a `code: string` property.

**Error type table:**

| Class | `code` pattern | Thrown by | When |
|-------|---------------|-----------|------|
| `AdapterError` | `adapter.*` | `call()`, `stream()` | Provider request fails (network, auth, rate limit) |
| `ValidationError` | `validation.*` | `validate()`, `call()` with schema | Output doesn't match schema |
| `ToolError` | `tool.*` | `execute()` | Tool handler throws or times out |
| `BudgetExhausted` | `budget.exhausted` | `agent()`, `call()` | Budget cap hit before completion |
| `ParseError` | `parse.*` | adapter internals | Provider response can't be parsed |
| `TimeoutError` | `timeout.*` | `execute()` | Tool exceeds timeout |
| `NotImplementedError` | `not_implemented` | adapter internals | Feature not supported by adapter |
| `DependencyCycleError` | — (plain Error) | `resolveOrder()` | Circular dependency in landlord contracts |

For each error: description, what triggers it, how to handle it, code example showing `if (!res.ok && res.error instanceof BudgetExhausted)` pattern.

**Error handling patterns:**
- Narrowing by class: `instanceof BudgetExhausted`
- Narrowing by code: `error.code === 'adapter.rate_limit'`
- Re-throwing unknown errors safely
- Result<T> pattern review — why errors surface as `result.error` not thrown

---

## Workstream 7: Depth Pass on Existing Pages

Every existing page gets expanded to cover:

1. **Full TypeScript signatures** — every function, every option, every type. No "see source" cop-outs.
2. **All options documented** — every field in every options object, with type, default, and description.
3. **Edge cases and gotchas** — callout blocks for common mistakes.
4. **Cross-links** — link to related pages where natural.
5. **"Common mistakes" section** — at the bottom of pages with non-obvious footguns.

### Per-page requirements

**`/primitives/call.md`** — Add: `CallOptions` full field table, `CallResult` type breakdown, what happens when schema validation fails, how budget is consumed, difference between `call()` and `stream()` for the same prompt.

**`/primitives/stream.md`** — Add: all `StreamChunk` variant types (`text`, `tool_use`, `tool_result`, `usage`, `end`), how to accumulate chunks into a full response, cancellation with `AbortSignal`, budget consumption per chunk.

**`/primitives/tool.md`** — Add: `ToolSpec` full field table including `permissions`, `timeout`, `strict`; what `strict: true` does; how tool names are validated; handler return type options; how errors in handlers are surfaced.

**`/primitives/execute.md`** — Add: full `ExecuteOptions`, how validation errors are surfaced vs handler errors, using `execute()` for testing, difference from calling the handler directly.

**`/primitives/validate.md`** — Add: all Standard Schema libraries that work (Zod, Valibot, ArkType, Effect), what happens on validation failure, how `ValidationError` is structured, using `validate()` standalone vs inside `call()`.

**`/primitives/count.md`** — Add: heuristic fallback behavior (when adapter doesn't implement `count`), accuracy expectations, using count for pre-flight budget checks.

**`/primitives/agent.md`** — Add: `AgentOptions` full field table, `AgentOutput` type breakdown, how `onStep` callback works, dynamic tool loading per step, how `stopReason` maps to different stop conditions, multi-turn continuation pattern.

**`/features/budget.md`** — Add: `BudgetOptions` full field table, `remaining()` method, how budget is shared vs copied, budget exhaustion behavior, dollar cost calculation (how adapters report cost).

**`/features/compress.md`** — Add: each transform's full options, ordering recommendations, how `orderForCache` interacts with prompt caching, `summarize` transform's LLM call behavior.

**`/features/memory.md`** — Add: `messages()` vs `scratchpad()` vs `conversationMemory()` decision guide, `ConversationMemoryOptions` full field table, how auto-summarization decides when to summarize, thread safety considerations.

**`/features/rag.md`** — Add: `chunk()` options (size, overlap, strategy), `memoryStore()` vs custom `EmbeddingStore`, cosine similarity threshold tuning, how to swap in a production vector store.

**`/features/recipes.md`** — Add: `react()` full options and step structure, `retryValidate()` retry strategy options, `reflect()` reflection prompt customization, `summarize()` chunk size behavior.

**`/features/safety.md`** — Add: `detectInjection()` full options and return type, `redact()` pattern list and custom pattern support, `permissionedTools()` permission model, `requireApproval()` callback signature, `trustBoundary()` threshold configuration.

**`/features/graph.md`** — Add: `GraphNode` and `GraphEdge` type breakdown, conditional edge syntax, fan-out/fan-in patterns, checkpoint schema, `runStream()` event types, error handling in nodes.

**`/adapters/anthropic.md`** — Add: all `anthropicAdapter()` options, prompt cache hit/miss behavior, which models support caching, streaming vs non-streaming cache behavior, cost implications.

**`/adapters/openai-compat.md`** — Add: all `openAICompatAdapter()` options, provider-specific gotchas (Groq rate limits, Ollama local setup, DeepSeek API differences), model capability matrix.

**`/adapters/custom.md`** — Add: full `ProviderAdapter` interface with all optional methods, `NormalizedRequest` and `NormalizedResponse` full type breakdown, streaming implementation pattern, capability flags.

**`/guide/index.md`** — Add: expanded "why Flint" narrative, how the pieces fit together as a system diagram (text), design principles explained.

**`/guide/installation.md`** — Add: monorepo setup, Deno support status, Bun support status, common installation errors and fixes.

**`/guide/quick-start.md`** — Add: explain each line of the quick start (don't just show code), add a "what just happened?" section after each example.

**`/guide/v0-status.md`** — Add: specific list of what's stable vs unstable, what "v0" means for semver.

**`/examples/*.md`** — Add: explanation of what the example demonstrates, what to look for, variations to try.

---

## Workstream 8: New Examples

5 new pages under `docs/examples/`:

### `docs/examples/rag-pipeline.md` — RAG Pipeline
Full working example: chunk documents, store embeddings (mock embedder), retrieve relevant chunks, pass to `call()`. Shows the complete RAG loop with real code. Covers: chunking strategy, embedding interface, retrieval threshold, injecting context into messages.

### `docs/examples/multi-agent.md` — Multi-Agent with Landlord
Uses `orchestrate()` to build a 3-tenant pipeline: researcher → writer → reviewer. Shows: contract structure, dependency wiring, artifact flow, onEvent progress logging. Full runnable code.

### `docs/examples/tool-approval.md` — Tool Approval Flow
Uses `requireApproval()` to gate destructive tool calls. Shows: approval callback, how to approve/deny, how the agent responds to denial, building a CLI confirmation prompt.

### `docs/examples/memory-agent.md` — Memory-Backed Agent
Uses `conversationMemory()` with auto-summarization. Shows: multi-turn conversation that persists across calls, how summary kicks in, how to inspect memory state.

### `docs/examples/graph-workflow.md` — Graph Workflow with Checkpointing
Uses `@flint/graph` to build a structured 4-node pipeline with a conditional branch. Shows: node definitions, edge conditions, fan-out, checkpoint resume, `runStream()` event handling.

### VitePress config additions
```ts
{ text: 'RAG Pipeline', link: '/examples/rag-pipeline' },
{ text: 'Multi-Agent (Landlord)', link: '/examples/multi-agent' },
{ text: 'Tool Approval Flow', link: '/examples/tool-approval' },
{ text: 'Memory-Backed Agent', link: '/examples/memory-agent' },
{ text: 'Graph Workflow', link: '/examples/graph-workflow' },
```

---

## VitePress Config — Complete Updated Sidebar

```ts
nav: [
  { text: 'Guide', link: '/guide/' },
  { text: 'Primitives', link: '/primitives/call' },
  { text: 'Features', link: '/features/budget' },
  { text: 'Adapters', link: '/adapters/anthropic' },
  { text: 'Landlord', link: '/landlord/' },
  { text: 'Examples', link: '/examples/basic-call' },
  { text: 'Reference', link: '/reference/errors' },
  // v0 dropdown unchanged
]

sidebar:
  '/guide/': Guide (add: FAQ, Testing, vs-langchain)
  '/primitives/': unchanged
  '/features/': unchanged
  '/adapters/': unchanged
  '/landlord/': new section (6 pages)
  '/examples/': add 5 new pages
  '/reference/': new section (errors page)
```

---

## Constraints

- All code in docs must be real, runnable TypeScript matching the actual API
- Every option in every options object must be documented — no "see source"
- Tone: developer-to-developer, no marketing fluff, explain the WHY not just the WHAT
- Cross-link liberally — if a page mentions `budget`, link to `/features/budget`
- Every page ends with a "See also" section linking related pages
