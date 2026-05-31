# Landlord → Dynamic Workflows — Design Spec

**Date:** 2026-05-31
**Status:** Approved
**Package:** `@flint/landlord`
**Goal:** Port Claude Code's "ultracode" / dynamic-workflow capability into Flint's `landlord` package — as close to identical as possible — turning Landlord from a declarative auto-decomposition orchestrator into a script-driven workflow runtime that injects the same hooks (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`) with the same semantics, on top of Flint primitives.

---

## 1. Background & gap analysis

### What Landlord is today

A **declarative auto-decomposition** orchestrator:

- `decompose(prompt)` asks the LLM (via a forced `emit_plan` tool) to emit a `Contract[]` — a DAG of worker specs (`role`, `objective`, `subPrompt`, `checkpoints`, `outputSchema`, `dependsOn`, `maxRetries`).
- `resolveOrder()` topologically sorts contracts (DFS, `DependencyCycleError` on cycles).
- `orchestrate()` runs all contracts via `Promise.all` with per-role dependency gates, checkpoint validation (`validateCheckpoint`: ajv JSON-Schema tier + LLM-judge tier), retry-on-eviction up to `maxRetries`, escalation on exhaustion, and artifact handoff (`dep.field` injected into dependents).
- The plan is decided **once** by the model at decompose time, then statically executed.

### What ultracode / dynamic workflows is (the target)

A **script-based imperative** orchestrator. The model writes a plain-JS script with real control flow (loops, conditionals, fan-out) that deterministically drives subagents through injected hooks. Defining traits:

- `export const meta = {...}` (pure literal) + a body using `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`, `workflow()`.
- `agent(prompt, opts?)` — spawn a subagent; with `schema` it is forced to call a structured-output tool and the validated object is returned; without schema the final text is returned; `null` if skipped.
- `pipeline(items, ...stages)` — each item flows through all stages independently, **no barrier**.
- `parallel(thunks)` — concurrent with a **barrier**; a throwing thunk resolves to `null`.
- Concurrency cap `min(16, cpus-2)`; lifetime agent cap `1000`.
- Structured output validated at the tool-call layer (model retries on mismatch).
- Resume via journaling (`resumeFromRunId` replays the longest unchanged `agent()` prefix).
- Determinism sandbox: `Date.now`/`Math.random`/`new Date` throw inside scripts.
- `opts.model`, `opts.agentType`, `opts.isolation:'worktree'`.
- `workflow(nameOrRef, args)` runs another workflow inline (one level).

Orchestration is **code, not a declared DAG**.

### The port

Build a **workflow runtime** in `@flint/landlord` that injects those exact hooks and executes a workflow, built on Flint's `agent()` / `tool()` / `budget`. The runtime becomes the package core; `orchestrate()` is rebuilt as a built-in workflow on top of it.

---

## 2. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Authoring model | **Both** — typed `defineWorkflow({meta, run})` for devs **and** `runWorkflowScript(source)` for model-authored JS strings, sharing one runtime core. |
| 2 | Relationship to existing API | **Layer** — runtime is the core; `orchestrate()`/`decompose()`/`runTenant()`/`Contract` preserved and (for `orchestrate`) reimplemented on top. |
| 3 | Fidelity scope | **Maximum** — core hooks + schema + caps + events **plus** resume/journaling, determinism sandbox, agentType registry, per-agent model override, isolation (sandboxed workDir default + optional git-worktree backend). |
| 4 | Model-facing parity | **Yes** — ship `workflowTool()` (a Flint `tool()` exposing the runtime) + `WORKFLOW_TOOL_GUIDE` system prompt. |

---

## 3. Module layout

New `workflow/` subtree under `packages/landlord/src/`; `orchestrate.ts` rebuilt on it. Existing `decompose.ts`, `contract.ts`, `tenant.ts`, `validate.ts`, `tools/*` are reused.

```
packages/landlord/src/
  workflow/
    types.ts        # shared types: WorkflowContext, AgentOpts, WorkflowEvent, RuntimeConfig, WorkflowModule, Meta, stores
    concurrency.ts  # Semaphore(limit=min(16,cpus-2), floor 1) + global agent-cap guard (1000)
    budget.ts       # WorkflowBudget {total, spent(), remaining()} bridged onto flint Budget
    events.ts       # event emitter + WorkflowEvent union; maps to onEvent callback
    journal.ts      # JournalStore iface; memoryJournalStore(); fileJournalStore(dir) → agent-<n>.jsonl; keying + replay
    registry.ts     # createAgentRegistry() (+ built-ins default/Explore/code-reviewer); createWorkflowRegistry() (named scripts)
    isolation.ts    # IsolationBackend iface; workdirIsolation (default); gitWorktreeIsolation (optional)
    schema.ts       # jsonSchema → forced structured_output tool; ajv validate; retry-on-mismatch; returns validated value
    agentcall.ts    # the agent() hook: flint agent() + schema + agentType + isolation + model + journaling + events
    hooks.ts        # buildContext(run): assembles {agent,parallel,pipeline,phase,log,args,budget,workflow}
    runtime.ts      # runWorkflow(module, config): owns run state (counters, journal, budget, signal, phase), invokes run(ctx)
    meta.ts         # restricted literal-evaluator + Meta validation (name/description/phases/whenToUse/model)
    sandbox.ts      # determinism sandbox: throwing stubs for Date/Math.random/new Date/process/require/globalThis/fs
    script.ts       # runWorkflowScript(source, config): parse meta, strip exports, wrap in AsyncFunction, inject hooks+sandbox
    define.ts       # defineWorkflow({meta, run}) → WorkflowModule (typed authoring path)
    tool.ts         # workflowTool(config) → flint Tool; WORKFLOW_TOOL_GUIDE; orchestratorAgent() convenience
    index.ts        # re-exports of the workflow surface
  orchestrate.ts    # rebuilt: built-in auto-decompose workflow on the runtime; public signature preserved
  decompose.ts contract.ts tenant.ts validate.ts   # reused (decompose + checkpoints power the built-in workflow)
  tools/…           # unchanged; standardTools(workDir) is the default agentType toolset
  index.ts          # exports runtime headline + preserved orchestrate/decompose/runTenant
```

`package.json` `exports` gains `"./workflow"` (in addition to `.` and `./tools`); the headline runtime symbols are **also** re-exported from `.` so the package's main entry reads as the workflow runtime.

---

## 4. The hook API

Identical names and semantics to the Workflow tool. The same object is injected as globals in a string script and passed as `wf` to a typed workflow.

```ts
type WorkflowContext = {
  // no schema → resolves the agent's final assistant text (string)
  // with schema → resolves the validated structured object
  // null only when a wrapping combinator catches an error (see parallel/pipeline)
  agent(prompt: string, opts?: AgentOpts): Promise<unknown>;

  // BARRIER: awaits all thunks; a thunk that throws (or whose agent errors) resolves to null, never rejects
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]>;

  // NO barrier between stages: each item flows through all stages independently.
  // stage signature: (prevResult, originalItem, index). A stage throw drops that item to null and skips its remaining stages.
  pipeline(items: unknown[], ...stages: StageFn[]): Promise<unknown[]>;

  phase(title: string): void;          // starts/switches the current progress group
  log(message: string): void;          // narrator progress line (emitted as a WorkflowEvent)

  args: unknown;                        // the value passed as RuntimeConfig.args, verbatim

  budget: {
    total: number | null;              // token target, or null when unset
    spent(): number;                   // output tokens used this run (main + nested)
    remaining(): number;               // max(0, total - spent()) or Infinity when total is null
  };

  // run another workflow inline; shares this run's concurrency cap, agent counter, budget, signal, journal.
  // one level only — workflow() inside a child throws.
  workflow(ref: string | { scriptPath?: string; source?: string }, args?: unknown): Promise<unknown>;
};

type AgentOpts = {
  label?: string;                      // display label override (defaults to a slug of the prompt / phase)
  phase?: string;                      // explicit progress group for this call (avoids races in parallel/pipeline)
  schema?: object;                     // JSON Schema → forced structured output; return value is validated
  model?: string;                      // per-agent model override
  isolation?: 'worktree';              // select the git-worktree isolation backend for this agent
  agentType?: string;                  // resolve a preset from the AgentTypeRegistry; composes with schema
};

type StageFn = (prev: unknown, originalItem: unknown, index: number) => unknown | Promise<unknown>;
```

`parallel`/`pipeline` are **plain combinators over `agent()`** — they do not themselves call the model; they only schedule the thunks/stages the script provides through the shared semaphore.

---

## 5. Execution semantics

### 5.1 Concurrency & caps (`concurrency.ts`)

- A `Semaphore` with `limit = max(1, min(16, os.cpus().length - 2))`. Every `agent()` acquires a slot before running and releases after; excess calls queue. `parallel`/`pipeline` fan work out but only `limit` agents run at once.
- A per-run lifetime counter increments on each `agent()` start; the 1001st throws `AgentCapError` (a `FlintError`-style class with `code: 'workflow.agent_cap'`). The cap is a runaway backstop.

### 5.2 `agent()` (`agentcall.ts`)

Order of operations for one call:

1. **Resume check** — compute `key = { index, hash(prompt, opts) }` (index is the monotonic call counter). If resuming and the journal entry at `index` exists with a matching hash, return its cached result immediately (no model call, no slot). The first mismatch/new index runs live; everything after re-runs live.
2. **Acquire** a concurrency slot; increment + check the agent cap.
3. **Resolve preset** from `agentType` (default = `'default'`): `{ systemPrompt, tools?(workDir), model? }`.
4. **Resolve model**: `opts.model ?? preset.model ?? config.models.default` (the runtime's `RuntimeConfig.models` is `{ default: string; [tier: string]: string }`; `orchestrate()` maps its `tenantModel` → `models.default`, and uses `landlordModel` for the decompose phase).
5. **Isolation**: obtain a `workDir` from the chosen backend (`workdirIsolation` default; `gitWorktreeIsolation` when `opts.isolation === 'worktree'`). Build `tools = preset.tools?.(workDir) ?? standardTools(workDir)`.
6. **Schema** (if present): append a forced `structured_output` tool (`schema.ts`) whose `jsonSchema = opts.schema`; instruct the agent it must call it. ajv-validate the call; on failure return a tool error (`"… does not match schema: <ajv errors>. Revise and call structured_output again."`) so the flint `agent()` loop retries; capture the validated value.
7. **Run** flint `agent({ adapter, model, messages:[{role:'system',content:systemPrompt+context},{role:'user',content:prompt}], tools, budget })`.
8. **Emit** `agent_started` before, `agent_complete`/`agent_error` after; **journal** the result (`{index, hash, result}`); release the slot; release/clean the isolation workDir.
9. **Return**: schema → validated object; otherwise final assistant text. A hard error throws out of `agent()` (and is converted to `null` only by a wrapping `parallel`/`pipeline`).

### 5.3 `parallel` & `pipeline` (`hooks.ts`)

- `parallel(thunks)` → `Promise.all(thunks.map(run-with-catch))`; each thunk's rejection/`agent()` error becomes `null`. Never rejects.
- `pipeline(items, ...stages)` → for each item, an independent async chain through the stages with **no cross-item barrier**; wall-clock = slowest single-item chain. Stage callback gets `(prev, originalItem, index)`. A throwing stage sets that item's result to `null` and skips its remaining stages. Returns an array aligned to `items`.

### 5.4 Budget (`budget.ts`)

Bridged onto flint's shared `Budget` (passed to every `agent()` so usage is cumulative). `WorkflowBudget.total` = the run's token target (`config.budget` token cap, or `null`); `spent()` reads the flint budget's token usage; `remaining()` = `max(0, total - spent())` or `Infinity`. Hitting the cap makes flint `agent()` fail with `BudgetExhausted`, surfaced as a thrown error from `agent()` — enabling `while (budget.total && budget.remaining() > N) {…}` loops and `Math.floor(budget.total / 100_000)` fleet sizing.

### 5.5 Events (`events.ts`)

```ts
type WorkflowEvent =
  | { type: 'phase_started'; title: string }
  | { type: 'log'; message: string }
  | { type: 'agent_started'; label: string; phase?: string; agentType: string; model: string }
  | { type: 'agent_complete'; label: string; phase?: string; tokens: number }
  | { type: 'agent_error'; label: string; phase?: string; error: string }
  | { type: 'workflow_complete'; result: unknown };
```

Delivered via `config.onEvent`. `config.signal?: AbortSignal` cancels the run (in-flight agents abort, queued agents are skipped) — the library analogue of background-run + abort. This mirrors the existing `LandlordEvent`/`onEvent` style.

---

## 6. Signature fidelity features

### 6.1 Resume / journaling (`journal.ts`)

```ts
interface JournalStore {
  append(runId: string, entry: JournalEntry): Promise<void>;
  load(runId: string): Promise<JournalEntry[]>;
}
type JournalEntry = { index: number; hash: string; result: unknown };
```

- `memoryJournalStore()` (default, non-persistent) and `fileJournalStore(dir)` (writes `agent-<index>.jsonl`).
- `runWorkflowScript(source, { resumeFromRunId, runId, journal })`: on resume, replay the **longest unchanged prefix** — for each `index`, if the stored hash matches the about-to-run `hash(prompt, opts)`, return the cached `result`; the first divergence and everything after runs live. Same script + same args ⇒ 100% hit.
- Replay correctness depends on a deterministic call sequence — guaranteed in string mode by the sandbox (§6.2) and documented as a constraint for typed workflows.

### 6.2 Determinism sandbox (`sandbox.ts`)

String scripts execute in an `AsyncFunction` whose parameter list **shadows** nondeterministic / host globals with throwing stubs: `Date` (and `Date.now`), `Math` (a clone with a throwing `random`), `process`, `require`, `globalThis`, `fs`, `import`-like access. Standard pure built-ins (`JSON`, `Array`, `Object`, `Math` minus `random`, etc.) remain. This mirrors the product ("`Date.now()`/`Math.random()`/`new Date()` throw") and is the precondition for §6.1. Typed workflows are not sandboxed (cannot shadow lexical globals) but carry the same documented "no nondeterminism if you want resume" constraint.

### 6.3 agentType registry (`registry.ts`)

```ts
type AgentType = { systemPrompt: string; tools?: (workDir: string) => Tool[]; model?: string };
function createAgentRegistry(types?: Record<string, AgentType>): AgentTypeRegistry; // merges over built-ins
```

Built-ins mirroring Claude Code:

| Name | Tools | System prompt focus |
|------|-------|---------------------|
| `default` | `standardTools(workDir)` (file r/w, bash, web) | general worker; structured results via tools |
| `Explore` | read-only: `fileReadTool`, read-only `bashTool`, `webFetchTool` | broad search; reads excerpts, returns conclusions, no writes |
| `code-reviewer` | read tools | review for bugs/quality; returns findings |

`opts.agentType` resolves a preset; when combined with `schema`, the preset's system prompt is used **and** the structured-output instruction is appended (composes).

### 6.4 Per-agent model override

`opts.model` wins, then preset `model`, then `config.models.default`. `config.models` carries named tiers (e.g. `{ default, fast }`) that presets/scripts reference by key.

### 6.5 Isolation (`isolation.ts`)

```ts
interface IsolationBackend { acquire(runId: string, label: string): Promise<{ workDir: string; release(): Promise<void> }>; }
```

- `workdirIsolation(baseDir)` (default): a fresh sandboxed subdir per agent, reusing Landlord's path-guarded tools. `release()` is a no-op (kept for inspection).
- `gitWorktreeIsolation(repoDir, baseDir)`: `git worktree add` a throwaway worktree per agent; `release()` runs `git worktree remove` (auto-removed if unchanged). Selected by `opts.isolation === 'worktree'`; falls back to `workdirIsolation` with a `log()` warning when `repoDir` is not a git repo.

---

## 7. String vs typed authoring + `meta`

### 7.1 `meta` (`meta.ts`)

```ts
type Meta = {
  name: string;                 // required
  description: string;          // required
  whenToUse?: string;
  model?: string;
  phases?: Array<{ title: string; detail?: string; model?: string }>;
};
```

A **restricted literal-evaluator** parses `export const meta = { … }`: only object/array/string/number/boolean/null literals are allowed (no identifiers, calls, spreads, template interpolation), matching the product's "pure literal" rule. Invalid meta → a clear `MetaError` (`code: 'workflow.meta'`).

### 7.2 String path (`script.ts`)

`runWorkflowScript(source, config)`:

1. Extract and parse `export const meta = {…}` via `meta.ts`.
2. Strip the `export const meta` statement and any other `export`/`import` lines (string scripts are not real modules).
3. Wrap the remaining body — which may use top-level `await` and a final `return` — in `new AsyncFunction(...hookNames, ...sandboxStubNames, body)`.
4. Invoke with the hook implementations (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`) and the sandbox stubs.
5. Resolve to the body's `return` value, emit `workflow_complete`.

### 7.3 Typed path (`define.ts`)

```ts
function defineWorkflow(def: { meta: Meta; run: (wf: WorkflowContext) => Promise<unknown> }): WorkflowModule;
```

Type-checked, no eval; produces a `WorkflowModule` the runtime executes identically. `runWorkflow(module, config)` is the shared entry both paths funnel into.

---

## 8. `workflowTool` + guide (`tool.ts`)

```ts
function workflowTool(config: {
  adapter: ProviderAdapter;
  models: { default: string; [tier: string]: string };
  registry?: WorkflowRegistry;        // named saved workflows for workflow(name)/{name}
  agentTypes?: AgentTypeRegistry;
  journal?: JournalStore;
  isolation?: IsolationBackend;
  onEvent?: (e: WorkflowEvent) => void;
}): Tool;
```

- Flint `tool()` named `workflow`, input `{ script: string; args?: unknown; name?: string; scriptPath?: string; resumeFromRunId?: string }`.
- Handler runs the runtime (`runWorkflowScript` for `script`, or registry lookup for `name`) and returns `{ runId, result }` (result summarized if large).
- `WORKFLOW_TOOL_GUIDE: string` — a system-prompt block adapted from the real Workflow tool description (pipeline-by-default, parallel-is-a-barrier, schema for structured output, adversarial-verify, judge-panel, loop-until-dry, multi-modal sweep, completeness-critic, no-silent-caps). Drop the tool + guide into any `agent()` and that agent authors-and-runs workflows exactly like Claude Code.
- `orchestratorAgent(config)` — convenience that returns a configured `agent()` wired with `workflowTool` + the guide as system prompt.

---

## 9. `orchestrate()` rebuilt on the runtime (`orchestrate.ts`)

`orchestrate()`, `decompose()`, `runTenant()`, `Contract`, `resolveOrder()`, `DependencyCycleError`, and all existing exported types **keep their signatures**, and the existing `orchestrate.test.ts` must pass unchanged. Internally `orchestrate()` becomes a built-in workflow:

1. `phase('decompose')` → `decompose(prompt)` → `Contract[]`; `resolveOrder()` for the cycle check (still throws `DependencyCycleError`).
2. Schedule tenants with the existing per-role dependency-gate logic, but run each tenant through the **runtime's `agent()` path** (a `tenant` agentType that applies checkpoints + `maxRetries` via the existing `runTenant` internals) so tenants inherit the semaphore, agent cap, journaling, budget, and events.
3. Map runtime `WorkflowEvent`s back onto the existing `LandlordEvent` names (`tenant_started`, `checkpoint_passed`, `tenant_complete`, `tenant_evicted`, `tenant_escalated`, `job_complete`) so `onEvent` consumers are unaffected.
4. Return the same `OrchestrateResult` shape.

Net effect: the auto-decompose feature becomes one built-in workflow; nothing in the public API is removed.

---

## 10. Public exports & packaging

- `src/index.ts` adds the runtime headline: `defineWorkflow`, `runWorkflowScript`, `runWorkflow`, `workflowTool`, `WORKFLOW_TOOL_GUIDE`, `orchestratorAgent`, `createAgentRegistry`, `createWorkflowRegistry`, `memoryJournalStore`, `fileJournalStore`, `workdirIsolation`, `gitWorktreeIsolation`, and all workflow types — alongside the preserved `orchestrate`/`decompose`/`runTenant`/`validateCheckpoint`/`ContractSchema`/`CheckpointSchema` exports.
- `package.json` `exports` adds `"./workflow": { types, import }`. `dependencies` unchanged (`ajv` reused for schema validation; `zod` for contracts). No new runtime deps in `flint` core.
- Biome/TS conventions: ESM, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, single quotes, semicolons, trailing commas, `useImportType`, **no default exports** (use named factory functions), `Result<T>` over throws at public boundaries where the existing package already does so (`runWorkflowScript`/`runWorkflow` return `Promise<Result<WorkflowRunResult>>`; hook-internal errors throw within the script as the product does).

---

## 11. Testing plan

vitest in `packages/landlord/test/workflow/`, using flint `mockAdapter`/`scriptedAdapter` (no network):

| File | Covers |
|------|--------|
| `concurrency.test.ts` | semaphore never exceeds `min(16,cpus-2)`; agent cap throws on the 1001st |
| `runtime.test.ts` | `parallel` barrier + throw→null; `pipeline` no-barrier ordering + stage-throw→null; `args`/`phase`/`log` events |
| `schema.test.ts` | forced structured-output tool; ajv validate; retry-on-mismatch returns the corrected value |
| `budget.test.ts` | `total`/`spent()`/`remaining()` math; exhaustion throws from `agent()` |
| `journal.test.ts` | unchanged-prefix replay (cache hit, no model call); first-divergence reruns live; file store JSONL round-trip |
| `sandbox.test.ts` | `Date.now`/`new Date`/`Math.random`/`process` throw inside a script; pure built-ins work; top-level await + return |
| `registry.test.ts` | built-in presets resolve; `agentType` composes with `schema`; custom registry merges over built-ins |
| `isolation.test.ts` | `workdirIsolation` creates distinct sandboxed dirs; worktree backend falls back cleanly outside a git repo |
| `meta.test.ts` | literal-evaluator accepts pure literals, rejects calls/identifiers/spreads |
| `tool.test.ts` | `workflowTool` runs a scripted-adapter-authored workflow end-to-end; returns `{runId,result}` |
| `define.test.ts` | typed `defineWorkflow` runs identically to the equivalent string script |
| `orchestrate.test.ts` (existing) | **must pass unchanged** (backward compat) |

A Changeset (`pnpm changeset`) describes the new `@flint/landlord` workflow surface.

---

## 12. Docs plan

- New `docs/landlord/workflow.md` (overview + mental model), `docs/landlord/hooks.md` (full hook reference), `docs/landlord/resume.md`, `docs/landlord/agent-types.md`, `docs/landlord/isolation.md`, `docs/landlord/workflow-tool.md`.
- Update `docs/landlord/index.md` (add the workflow-runtime mental model alongside the tenant model) and `docs/landlord/orchestrate.md` (note it is now runtime-backed; behavior unchanged).
- New example `docs/examples/dynamic-workflow.md` (a review→verify pipeline script, both string and typed).
- VitePress `docs/.vitepress/config.ts` sidebar/nav additions; README `## Packages` / Landlord bullet mention of the workflow runtime.
- All code samples real and runnable against the actual API (project doc norm).

---

## 13. Constraints & non-goals

- **Backward compatibility:** `orchestrate`/`decompose`/`runTenant`/`Contract` public API and existing tests preserved.
- **No network in tests:** all behavior tested via mock/scripted adapters.
- **Out of scope (harness-coupled, intentionally not ported):** the `/workflows` TUI progress tree (replaced by `onEvent`), background task scheduling + `<task-notification>` (replaced by the async `runWorkflow` + `AbortSignal`), MCP `ToolSearch` deferred-tool loading (callers pass tools/agentTypes explicitly). These are noted in docs as the library's equivalents.
- **Determinism in typed mode** cannot be enforced lexically; documented as a resume precondition rather than sandboxed.
- **Single-level `workflow()` nesting**, matching the product (nested `workflow()` throws).

---

## 14. File-by-file work breakdown (for the implementation plan)

Independent-ish units, buildable in parallel where noted:

1. `workflow/types.ts`, `workflow/events.ts`, `workflow/concurrency.ts`, `workflow/budget.ts` — foundation types + primitives (parallel-safe).
2. `workflow/journal.ts`, `workflow/registry.ts`, `workflow/isolation.ts` — stores/registries/backends (parallel-safe, depend on 1).
3. `workflow/schema.ts`, `workflow/agentcall.ts` — the agent() hook + structured output (depends on 1–2).
4. `workflow/hooks.ts`, `workflow/runtime.ts` — context assembly + run engine (depends on 1–3).
5. `workflow/meta.ts`, `workflow/sandbox.ts`, `workflow/script.ts`, `workflow/define.ts` — authoring paths (depends on 4).
6. `workflow/tool.ts` (+ `WORKFLOW_TOOL_GUIDE`, `orchestratorAgent`) — model-facing parity (depends on 5).
7. `orchestrate.ts` rebuild + `index.ts`/`package.json` wiring (depends on 4–5).
8. Tests (§11), docs (§12), Changeset.
