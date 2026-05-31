# Landlord Dynamic Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Claude Code's "ultracode" / dynamic-workflow runtime into `@flint/landlord` — a script-driven workflow engine that injects the same hooks (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`) on top of Flint primitives, with structured-output schemas, concurrency/agent caps, resume/journaling, a determinism sandbox, an agentType registry, isolation backends, and a model-facing `workflowTool`.

**Architecture:** A new `packages/landlord/src/workflow/` subtree becomes the package core. The run engine (`runtime.ts`) owns per-run state (semaphore, agent counter, budgets, journal, event emitter, runId) and executes a `WorkflowModule` (`{ meta, run }`). Two authoring paths produce a module: `defineWorkflow()` (typed) and `runWorkflowScript()` (a JS string compiled in a determinism sandbox). The same hooks reach the script as injected globals and the typed function as a `wf` context. `orchestrate()` is rebuilt as a built-in auto-decompose workflow on the runtime while preserving its public API and existing tests.

**Tech Stack:** TypeScript 5.7 (ESM, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Flint core (`flint`, `flint/budget`, `flint/errors`, `flint/testing`), `ajv` (schema validation), `zod` (tool input), `vitest`, Biome (single quotes, semicolons, trailing commas, `useImportType`, no default exports), `tsup` build.

**Conventions every task follows:**
- All relative imports use the `.ts` extension (e.g. `from './errors.ts'`) — required by `allowImportingTsExtensions`.
- Use `import type` for type-only imports (Biome `useImportType` is an error).
- No default exports (Biome error) — named factory functions/classes only.
- For optional object properties assigned conditionally, use the spread guard pattern `...(x !== undefined ? { x } : {})` (required by `exactOptionalPropertyTypes`).
- Working directory for all commands: `packages/landlord/`. Run a single test file with `pnpm vitest run test/workflow/<name>.test.ts`.
- Commit after each task with the message shown.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/workflow/errors.ts` | `WorkflowError`, `AgentCapError`, `MetaError` (extend `FlintError`) |
| `src/workflow/types.ts` | Pure shared types: `AgentOpts`, `StageFn`, `WorkflowContext`, `WorkflowEvent`, `Meta`, `WorkflowModule`, `Models`, `WorkflowBudgetView`, `WorkflowRunResult` |
| `src/workflow/concurrency.ts` | `defaultConcurrency()`, `Semaphore`, `AgentCounter` |
| `src/workflow/budget.ts` | `WorkflowBudget` (token-target tracker) + `budgetView()` |
| `src/workflow/events.ts` | `EventEmitter`, `EventSink` |
| `src/workflow/journal.ts` | `JournalEntry`, `JournalStore`, `memoryJournalStore()`, `fileJournalStore()`, `hashCall()` |
| `src/workflow/registry.ts` | `AgentType`, `AgentTypeRegistry`, `createAgentRegistry()`, `WorkflowRegistry`, `createWorkflowRegistry()` |
| `src/workflow/isolation.ts` | `IsolationBackend`, `IsolationLease`, `workdirIsolation()`, `gitWorktreeIsolation()` |
| `src/workflow/schema.ts` | `makeStructuredOutput()` — forced structured-output tool + ajv validation |
| `src/workflow/agentcall.ts` | `RunDeps`, `runAgentCall()` — the `agent()` hook |
| `src/workflow/hooks.ts` | `buildContext()` — assembles the `WorkflowContext` (parallel/pipeline/phase/log/budget/workflow) |
| `src/workflow/runtime.ts` | `RuntimeConfig`, `runWorkflow()`, `runWorkflowScript()` — the run engine |
| `src/workflow/meta.ts` | `parseMeta()`, `parseLiteral()` — restricted JS-literal parser |
| `src/workflow/sandbox.ts` | `sandboxBindings()` — throwing stubs for Date/Math.random/process/etc. |
| `src/workflow/script.ts` | `compileScript()`, `stripModuleSyntax()` |
| `src/workflow/define.ts` | `defineWorkflow()` |
| `src/workflow/tool.ts` | `workflowTool()`, `WORKFLOW_TOOL_GUIDE`, `orchestratorAgent()` |
| `src/workflow/index.ts` | Re-exports of the workflow surface |
| `src/orchestrate.ts` | Rebuilt: auto-decompose workflow on the runtime (public API preserved) |
| `src/index.ts` | Adds runtime headline exports |
| `package.json`, `tsup.config.ts` | Add `./workflow` export + build entry |

---

## Task 1: Workflow errors + shared types

**Files:**
- Create: `packages/landlord/src/workflow/errors.ts`
- Create: `packages/landlord/src/workflow/types.ts`
- Test: `packages/landlord/test/workflow/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/workflow/types.test.ts
import { describe, expect, it } from 'vitest';
import { AgentCapError, MetaError, WorkflowError } from '../../src/workflow/errors.ts';

describe('workflow errors', () => {
  it('WorkflowError carries a code and name', () => {
    const e = new WorkflowError('boom', 'workflow.test');
    expect(e.code).toBe('workflow.test');
    expect(e.name).toBe('WorkflowError');
    expect(e).toBeInstanceOf(Error);
  });

  it('AgentCapError and MetaError have fixed codes', () => {
    expect(new AgentCapError('x').code).toBe('workflow.agent_cap');
    expect(new MetaError('x').code).toBe('workflow.meta');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/workflow/types.test.ts`
Expected: FAIL — cannot find module `../../src/workflow/errors.ts`.

- [ ] **Step 3: Write `errors.ts`**

```ts
// src/workflow/errors.ts
import { FlintError } from 'flint/errors';

export class WorkflowError extends FlintError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, { code, ...(cause !== undefined ? { cause } : {}) });
    this.name = 'WorkflowError';
  }
}

export class AgentCapError extends WorkflowError {
  constructor(message: string) {
    super(message, 'workflow.agent_cap');
    this.name = 'AgentCapError';
  }
}

export class MetaError extends WorkflowError {
  constructor(message: string) {
    super(message, 'workflow.meta');
    this.name = 'MetaError';
  }
}
```

- [ ] **Step 4: Write `types.ts`**

```ts
// src/workflow/types.ts
import type { ProviderAdapter, Tool } from 'flint';

export type Models = { default: string } & Record<string, string>;

export type AgentOpts = {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  model?: string;
  isolation?: 'worktree';
  agentType?: string;
};

export type StageFn = (
  prev: unknown,
  originalItem: unknown,
  index: number,
) => unknown | Promise<unknown>;

export type WorkflowBudgetView = {
  total: number | null;
  spent: () => number;
  remaining: () => number;
};

export type WorkflowContext = {
  agent: (prompt: string, opts?: AgentOpts) => Promise<unknown>;
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>;
  pipeline: (items: unknown[], ...stages: StageFn[]) => Promise<unknown[]>;
  phase: (title: string) => void;
  log: (message: string) => void;
  args: unknown;
  budget: WorkflowBudgetView;
  workflow: (
    ref: string | { scriptPath?: string; source?: string },
    args?: unknown,
  ) => Promise<unknown>;
};

export type WorkflowEvent =
  | { type: 'phase_started'; title: string }
  | { type: 'log'; message: string }
  | { type: 'agent_started'; label: string; phase?: string; agentType: string; model: string }
  | { type: 'agent_complete'; label: string; phase?: string; tokens: number }
  | { type: 'agent_error'; label: string; phase?: string; error: string }
  | { type: 'workflow_complete'; result: unknown };

export type MetaPhase = { title: string; detail?: string; model?: string };

export type Meta = {
  name: string;
  description: string;
  whenToUse?: string;
  model?: string;
  phases?: MetaPhase[];
};

export type WorkflowModule = {
  meta: Meta;
  run: (wf: WorkflowContext) => Promise<unknown>;
};

export type WorkflowRunResult = {
  runId: string;
  result: unknown;
  events: WorkflowEvent[];
};

// Re-exported here so consumers can build tool registries without importing flint directly.
export type { ProviderAdapter, Tool };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/workflow/types.test.ts && pnpm typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/landlord/src/workflow/errors.ts packages/landlord/src/workflow/types.ts packages/landlord/test/workflow/types.test.ts
git commit -m "feat(landlord): workflow errors and shared types"
```

---

## Task 2: Concurrency — Semaphore + agent cap

**Files:**
- Create: `packages/landlord/src/workflow/concurrency.ts`
- Test: `packages/landlord/test/workflow/concurrency.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/workflow/concurrency.test.ts
import { describe, expect, it } from 'vitest';
import { AgentCapError } from '../../src/workflow/errors.ts';
import { AgentCounter, Semaphore, defaultConcurrency } from '../../src/workflow/concurrency.ts';

describe('Semaphore', () => {
  it('never runs more than `limit` tasks concurrently', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      const release = await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      release();
    };
    await Promise.all(Array.from({ length: 8 }, () => task()));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('AgentCounter', () => {
  it('throws AgentCapError past the cap', () => {
    const c = new AgentCounter(3);
    c.increment();
    c.increment();
    c.increment();
    expect(() => c.increment()).toThrow(AgentCapError);
  });
});

describe('defaultConcurrency', () => {
  it('is at least 1 and at most 16', () => {
    const n = defaultConcurrency();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(16);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/workflow/concurrency.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `concurrency.ts`**

```ts
// src/workflow/concurrency.ts
import { cpus } from 'node:os';
import { AgentCapError } from './errors.ts';

export function defaultConcurrency(): number {
  return Math.max(1, Math.min(16, cpus().length - 2));
}

/**
 * Counting semaphore. The fast path (slot available) runs synchronously up to
 * `active++`, so concurrent synchronous `acquire()` calls cannot oversubscribe.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

export class AgentCounter {
  private count = 0;

  constructor(private readonly cap: number = 1000) {}

  increment(): void {
    this.count += 1;
    if (this.count > this.cap) {
      throw new AgentCapError(`Workflow exceeded the ${this.cap}-agent cap`);
    }
  }

  get value(): number {
    return this.count;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/workflow/concurrency.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/landlord/src/workflow/concurrency.ts packages/landlord/test/workflow/concurrency.test.ts
git commit -m "feat(landlord): concurrency semaphore and agent cap"
```

---

## Task 3: Workflow budget

**Files:**
- Create: `packages/landlord/src/workflow/budget.ts`
- Test: `packages/landlord/test/workflow/budget.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/workflow/budget.test.ts
import { describe, expect, it } from 'vitest';
import { WorkflowBudget, budgetView } from '../../src/workflow/budget.ts';

describe('WorkflowBudget', () => {
  it('tracks spent output tokens and computes remaining against a target', () => {
    const wb = new WorkflowBudget(100);
    wb.record({ input: 10, output: 30 });
    wb.record({ input: 5, output: 20 });
    expect(wb.spent()).toBe(50);
    expect(wb.remaining()).toBe(50);
  });

  it('remaining is Infinity when total is null', () => {
    const wb = new WorkflowBudget(null);
    wb.record({ output: 1000 });
    expect(wb.spent()).toBe(1000);
    expect(wb.remaining()).toBe(Number.POSITIVE_INFINITY);
  });

  it('budgetView exposes total/spent/remaining bound to the instance', () => {
    const wb = new WorkflowBudget(10);
    const view = budgetView(wb);
    wb.record({ output: 4 });
    expect(view.total).toBe(10);
    expect(view.spent()).toBe(4);
    expect(view.remaining()).toBe(6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/workflow/budget.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `budget.ts`**

```ts
// src/workflow/budget.ts
import type { WorkflowBudgetView } from './types.ts';

/**
 * Tracks the run's output-token spend against an optional target (the ultracode
 * "+500k"-style ceiling). `total === null` means no target → unbounded remaining.
 */
export class WorkflowBudget {
  private outputTokens = 0;
  readonly total: number | null;

  constructor(total: number | null) {
    this.total = total;
  }

  record(usage: { input?: number; output?: number; cached?: number }): void {
    this.outputTokens += usage.output ?? 0;
  }

  spent(): number {
    return this.outputTokens;
  }

  remaining(): number {
    return this.total === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.total - this.outputTokens);
  }
}

export function budgetView(wb: WorkflowBudget): WorkflowBudgetView {
  return {
    total: wb.total,
    spent: () => wb.spent(),
    remaining: () => wb.remaining(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/workflow/budget.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/landlord/src/workflow/budget.ts packages/landlord/test/workflow/budget.test.ts
git commit -m "feat(landlord): workflow budget token-target tracker"
```

---

## Task 4: Event emitter

**Files:**
- Create: `packages/landlord/src/workflow/events.ts`
- Test: `packages/landlord/test/workflow/events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/workflow/events.test.ts
import { describe, expect, it } from 'vitest';
import { EventEmitter } from '../../src/workflow/events.ts';
import type { WorkflowEvent } from '../../src/workflow/types.ts';

describe('EventEmitter', () => {
  it('records events and forwards them to the sink', () => {
    const seen: WorkflowEvent[] = [];
    const em = new EventEmitter((e) => seen.push(e));
    em.emit({ type: 'log', message: 'hi' });
    em.emit({ type: 'phase_started', title: 'Find' });
    expect(seen).toHaveLength(2);
    expect(em.all().map((e) => e.type)).toEqual(['log', 'phase_started']);
  });

  it('works with no sink', () => {
    const em = new EventEmitter();
    em.emit({ type: 'log', message: 'x' });
    expect(em.all()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/workflow/events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `events.ts`**

```ts
// src/workflow/events.ts
import type { WorkflowEvent } from './types.ts';

export type EventSink = (event: WorkflowEvent) => void;

export class EventEmitter {
  private readonly events: WorkflowEvent[] = [];

  constructor(private readonly sink?: EventSink) {}

  emit(event: WorkflowEvent): void {
    this.events.push(event);
    this.sink?.(event);
  }

  all(): WorkflowEvent[] {
    return this.events;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/workflow/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/landlord/src/workflow/events.ts packages/landlord/test/workflow/events.test.ts
git commit -m "feat(landlord): workflow event emitter"
```

---

## Task 5: Journal (resume/replay)

**Files:**
- Create: `packages/landlord/src/workflow/journal.ts`
- Test: `packages/landlord/test/workflow/journal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/workflow/journal.test.ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileJournalStore, hashCall, memoryJournalStore } from '../../src/workflow/journal.ts';

describe('hashCall', () => {
  it('is stable regardless of opts key order', () => {
    const a = hashCall('p', { label: 'x', phase: 'y' });
    const b = hashCall('p', { phase: 'y', label: 'x' });
    expect(a).toBe(b);
  });
  it('changes when the prompt changes', () => {
    expect(hashCall('a', {})).not.toBe(hashCall('b', {}));
  });
});

describe('memoryJournalStore', () => {
  it('appends and loads entries in order', async () => {
    const s = memoryJournalStore();
    await s.append('run1', { index: 0, hash: 'h0', result: 'r0' });
    await s.append('run1', { index: 1, hash: 'h1', result: 'r1' });
    const entries = await s.load('run1');
    expect(entries.map((e) => e.result)).toEqual(['r0', 'r1']);
  });
});

describe('fileJournalStore', () => {
  it('round-trips entries through JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jrnl-'));
    const s = fileJournalStore(dir);
    await s.append('runA', { index: 0, hash: 'h', result: { ok: true } });
    const entries = await s.load('runA');
    expect(entries).toEqual([{ index: 0, hash: 'h', result: { ok: true } }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/workflow/journal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `journal.ts`**

```ts
// src/workflow/journal.ts
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type JournalEntry = { index: number; hash: string; result: unknown };

export interface JournalStore {
  append(runId: string, entry: JournalEntry): Promise<void>;
  load(runId: string): Promise<JournalEntry[]>;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',');
  return `{${body}}`;
}

/** FNV-1a (32-bit) hex of the stable-stringified call signature. */
export function hashCall(prompt: string, opts: unknown): string {
  const input = stableStringify({ prompt, opts: opts ?? {} });
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function memoryJournalStore(): JournalStore {
  const runs = new Map<string, JournalEntry[]>();
  return {
    async append(runId, entry) {
      const list = runs.get(runId) ?? [];
      list.push(entry);
      runs.set(runId, list);
    },
    async load(runId) {
      return [...(runs.get(runId) ?? [])];
    },
  };
}

export function fileJournalStore(dir: string): JournalStore {
  const path = (runId: string) => join(dir, `journal-${runId}.jsonl`);
  return {
    async append(runId, entry) {
      await mkdir(dir, { recursive: true });
      await appendFile(path(runId), `${JSON.stringify(entry)}\n`, 'utf-8');
    },
    async load(runId) {
      let text: string;
      try {
        text = await readFile(path(runId), 'utf-8');
      } catch {
        return [];
      }
      return text
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as JournalEntry);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/workflow/journal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/landlord/src/workflow/journal.ts packages/landlord/test/workflow/journal.test.ts
git commit -m "feat(landlord): journal store and call hashing for resume"
```

---

## Task 6: Registries (agent types + named workflows)

**Files:**
- Create: `packages/landlord/src/workflow/registry.ts`
- Test: `packages/landlord/test/workflow/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/workflow/registry.test.ts
import { describe, expect, it } from 'vitest';
import { WorkflowError } from '../../src/workflow/errors.ts';
import {
  createAgentRegistry,
  createWorkflowRegistry,
} from '../../src/workflow/registry.ts';

describe('createAgentRegistry', () => {
  it('resolves built-in types', () => {
    const reg = createAgentRegistry();
    expect(reg.has('default')).toBe(true);
    expect(reg.has('Explore')).toBe(true);
    expect(reg.has('code-reviewer')).toBe(true);
    expect(reg.resolve('default').tools?.('/tmp/x').length).toBeGreaterThan(0);
  });

  it('merges custom types over built-ins and throws on unknown', () => {
    const reg = createAgentRegistry({ custom: { systemPrompt: 'You are custom.' } });
    expect(reg.resolve('custom').systemPrompt).toBe('You are custom.');
    expect(() => reg.resolve('missing')).toThrow(WorkflowError);
  });
});

describe('createWorkflowRegistry', () => {
  it('resolves named sources', () => {
    const reg = createWorkflowRegistry({ greet: 'return "hi"' });
    expect(reg.resolve('greet')).toBe('return "hi"');
    expect(reg.resolve('nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/workflow/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `registry.ts`**

```ts
// src/workflow/registry.ts
import type { Tool } from 'flint';
import { WorkflowError } from './errors.ts';
import { bashTool, fileReadTool, webFetchTool } from '../tools/index.ts';
import { standardTools } from '../tools/index.ts';

export type AgentType = {
  systemPrompt: string;
  tools?: (workDir: string) => Tool[];
  model?: string;
};

export type AgentTypeRegistry = {
  resolve(name: string): AgentType;
  has(name: string): boolean;
};

export const BUILT_IN_AGENT_TYPES: Record<string, AgentType> = {
  default: {
    systemPrompt:
      'You are a focused worker agent. Use your tools to accomplish the task. ' +
      'When a structured result is requested, return it by calling the structured_output tool.',
    tools: (workDir) => standardTools(workDir),
  },
  Explore: {
    systemPrompt:
      'You are a read-only exploration agent. Search broadly, read excerpts rather than whole ' +
      'files, and return conclusions — never modify anything. You have read and web tools only.',
    tools: (workDir) => [fileReadTool(workDir), webFetchTool(workDir)],
  },
  'code-reviewer': {
    systemPrompt:
      'You are a code reviewer. Read the relevant code and report concrete issues (bugs, security, ' +
      'quality) with file and line references. Return findings via structured_output when asked.',
    tools: (workDir) => [fileReadTool(workDir), bashTool(workDir)],
  },
};

export function createAgentRegistry(custom?: Record<string, AgentType>): AgentTypeRegistry {
  const merged: Record<string, AgentType> = { ...BUILT_IN_AGENT_TYPES, ...(custom ?? {}) };
  return {
    has: (name) => name in merged,
    resolve: (name) => {
      const t = merged[name];
      if (t === undefined) {
        throw new WorkflowError(
          `Unknown agentType '${name}'. Known: ${Object.keys(merged).join(', ')}`,
          'workflow.unknown_agent_type',
        );
      }
      return t;
    },
  };
}

export type WorkflowRegistry = {
  resolve(name: string): string | undefined;
};

export function createWorkflowRegistry(scripts: Record<string, string>): WorkflowRegistry {
  return { resolve: (name) => scripts[name] };
}
```

> Note: `src/tools/index.ts` already exports `standardTools`, `fileReadTool`, `webFetchTool`, and `bashTool`. The two `import` lines are kept separate only for clarity; Biome's `organizeImports` will merge them on format — run `pnpm format` before committing if it complains.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/workflow/registry.test.ts && pnpm format`
Expected: PASS; format clean.

- [ ] **Step 5: Commit**

```bash
git add packages/landlord/src/workflow/registry.ts packages/landlord/test/workflow/registry.test.ts
git commit -m "feat(landlord): agent-type and workflow registries"
```

---

## Task 7: Isolation backends

**Files:**
- Create: `packages/landlord/src/workflow/isolation.ts`
- Test: `packages/landlord/test/workflow/isolation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/workflow/isolation.test.ts
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitWorktreeIsolation, workdirIsolation } from '../../src/workflow/isolation.ts';

describe('workdirIsolation', () => {
  it('creates a distinct existing directory per acquire', async () => {
    const base = await mkdtemp(join(tmpdir(), 'iso-'));
    const backend = workdirIsolation(base);
    const a = await backend.acquire('alpha');
    const b = await backend.acquire('alpha');
    expect(a.workDir).not.toBe(b.workDir);
    expect((await stat(a.workDir)).isDirectory()).toBe(true);
    await a.release();
    await b.release();
  });
});

describe('gitWorktreeIsolation', () => {
  it('falls back to a workdir lease outside a git repo', async () => {
    const base = await mkdtemp(join(tmpdir(), 'iso2-'));
    const notRepo = await mkdtemp(join(tmpdir(), 'norepo-'));
    const backend = gitWorktreeIsolation(notRepo, base);
    const lease = await backend.acquire('w');
    expect((await stat(lease.workDir)).isDirectory()).toBe(true);
    await lease.release();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/workflow/isolation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `isolation.ts`**

```ts
// src/workflow/isolation.ts
import { exec } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export type IsolationLease = { workDir: string; release: () => Promise<void> };

export interface IsolationBackend {
  acquire(label: string): Promise<IsolationLease>;
}

function sanitize(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'agent';
}

export function workdirIsolation(baseDir: string): IsolationBackend {
  let counter = 0;
  return {
    async acquire(label) {
      const workDir = join(baseDir, `${sanitize(label)}-${counter++}`);
      await mkdir(workDir, { recursive: true });
      return { workDir, release: async () => {} };
    },
  };
}

export function gitWorktreeIsolation(repoDir: string, baseDir: string): IsolationBackend {
  const fallback = workdirIsolation(baseDir);
  let counter = 0;
  return {
    async acquire(label) {
      try {
        await execAsync('git rev-parse --is-inside-work-tree', { cwd: repoDir });
      } catch {
        return fallback.acquire(label);
      }
      const workDir = join(baseDir, `wt-${sanitize(label)}-${counter++}`);
      try {
        await execAsync(`git worktree add --detach ${JSON.stringify(workDir)}`, { cwd: repoDir });
      } catch {
        return fallback.acquire(label);
      }
      return {
        workDir,
        release: async () => {
          try {
            await execAsync(`git worktree remove --force ${JSON.stringify(workDir)}`, {
              cwd: repoDir,
            });
          } catch {
            /* leave the worktree for inspection if removal fails */
          }
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/workflow/isolation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/landlord/src/workflow/isolation.ts packages/landlord/test/workflow/isolation.test.ts
git commit -m "feat(landlord): workdir and git-worktree isolation backends"
```

---

## Task 8: Structured output (schema → forced tool)

**Files:**
- Create: `packages/landlord/src/workflow/schema.ts`
- Test: `packages/landlord/test/workflow/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/workflow/schema.test.ts
import { execute } from 'flint';
import { describe, expect, it } from 'vitest';
import { makeStructuredOutput } from '../../src/workflow/schema.ts';

describe('makeStructuredOutput', () => {
  it('captures a valid object and reports success', async () => {
    const so = makeStructuredOutput({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    const res = await execute(so.tool, { name: 'ada' });
    expect(res.ok).toBe(true);
    expect(so.getValue()).toEqual({ name: 'ada' });
  });

  it('rejects an invalid object and leaves value undefined', async () => {
    const so = makeStructuredOutput({
      type: 'object',
      properties: { n: { type: 'number' } },
      required: ['n'],
    });
    const res = await execute(so.tool, { n: 'not-a-number' });
    expect(res.ok).toBe(true); // handler returns an error string, not a thrown error
    expect(String(res.ok ? res.value : '')).toMatch(/does not match/i);
    expect(so.getValue()).toBeUndefined();
  });

  it('wraps non-object schemas under a result key and unwraps the captured value', async () => {
    const so = makeStructuredOutput({ type: 'array', items: { type: 'string' } });
    await execute(so.tool, { result: ['a', 'b'] });
    expect(so.getValue()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/workflow/schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `schema.ts`**

```ts
// src/workflow/schema.ts
import Ajv from 'ajv';
import { tool } from 'flint';
import type { StandardSchemaV1, Tool } from 'flint';

const ajv = new Ajv({ allErrors: true });

function anyObjectSchema(): StandardSchemaV1<unknown, Record<string, unknown>> {
  return {
    '~standard': {
      version: 1,
      vendor: 'landlord',
      validate: (v) => {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          return { issues: [{ message: 'Expected an object' }] };
        }
        return { value: v as Record<string, unknown> };
      },
    },
  };
}

export type StructuredOutput = {
  tool: Tool;
  getValue: () => unknown;
};

/**
 * Build a forced `structured_output` tool for an `agent()` call. Object schemas
 * are presented as-is; non-object schemas are wrapped under a `result` key and
 * unwrapped on capture. The handler validates with ajv and returns a corrective
 * message on mismatch so the agent loop retries.
 */
export function makeStructuredOutput(schema: Record<string, unknown>): StructuredOutput {
  const wrapped = schema['type'] !== 'object';
  const jsonSchema: Record<string, unknown> = wrapped
    ? { type: 'object', properties: { result: schema }, required: ['result'] }
    : schema;

  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(jsonSchema);
  } catch {
    validate = ajv.compile({ type: 'object' });
  }

  let captured: unknown;
  let done = false;

  const t = tool({
    name: 'structured_output',
    description:
      'Return your final result as JSON matching the required schema. Call this exactly once.',
    input: anyObjectSchema(),
    jsonSchema,
    handler: (input: Record<string, unknown>) => {
      if (!validate(input)) {
        return `Output does not match the required schema: ${ajv.errorsText(validate.errors)}. Call structured_output again with corrected fields.`;
      }
      if (!done) {
        captured = wrapped ? (input as { result: unknown }).result : input;
        done = true;
      }
      return 'Accepted.';
    },
  }) as unknown as Tool;

  return { tool: t, getValue: () => captured };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/workflow/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/landlord/src/workflow/schema.ts packages/landlord/test/workflow/schema.test.ts
git commit -m "feat(landlord): structured-output tool with ajv validation"
```

## Task 9: The `agent()` hook

**Files:**
- Create: `packages/landlord/src/workflow/agentcall.ts`
- Test: `packages/landlord/test/workflow/agentcall.test.ts`

**Context:** `RunDeps` is the per-run state object threaded into both `runAgentCall` (here) and `buildContext` (Task 10). It is defined here because this is the first consumer. `runtime.ts` (Task 13) constructs it.

- [ ] **Step 1: Write the failing test**

```ts
// test/workflow/agentcall.test.ts
import type { NormalizedResponse } from 'flint';
import { budget as makeBudget } from 'flint/budget';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockAdapter, scriptedAdapter } from 'flint/testing';
import { describe, expect, it } from 'vitest';
import { WorkflowBudget } from '../../src/workflow/budget.ts';
import { AgentCounter, Semaphore } from '../../src/workflow/concurrency.ts';
import { EventEmitter } from '../../src/workflow/events.ts';
import { memoryJournalStore } from '../../src/workflow/journal.ts';
import { createAgentRegistry } from '../../src/workflow/registry.ts';
import { workdirIsolation } from '../../src/workflow/isolation.ts';
import { runAgentCall } from '../../src/workflow/agentcall.ts';
import type { RunDeps } from '../../src/workflow/agentcall.ts';

function textResponse(content: string): NormalizedResponse {
  return { message: { role: 'assistant', content }, usage: { input: 10, output: 5 }, stopReason: 'end' };
}
function toolCallResponse(name: string, args: unknown): NormalizedResponse {
  return {
    message: { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name, arguments: args }] },
    usage: { input: 20, output: 10 },
    stopReason: 'tool_call',
  };
}

async function makeDeps(adapter: RunDeps['adapter']): Promise<RunDeps> {
  const base = await mkdtemp(join(tmpdir(), 'ac-'));
  let index = 0;
  return {
    adapter,
    models: { default: 'test' },
    flintBudget: makeBudget({ maxSteps: 50 }),
    wfBudget: new WorkflowBudget(null),
    semaphore: new Semaphore(4),
    counter: new AgentCounter(1000),
    registry: createAgentRegistry(),
    workflows: undefined,
    isolation: workdirIsolation(base),
    worktreeIsolation: undefined,
    emitter: new EventEmitter(),
    journal: memoryJournalStore(),
    runId: 'run-test',
    resumeEntries: [],
    signal: undefined,
    args: undefined,
    depth: 0,
    nextIndex: () => index++,
    currentPhase: { value: undefined },
  };
}

describe('runAgentCall', () => {
  it('returns the final text for a no-schema call and records the journal', async () => {
    const deps = await makeDeps(scriptedAdapter([textResponse('hello world')]));
    const result = await runAgentCall('say hi', undefined, deps);
    expect(result).toBe('hello world');
    expect(await deps.journal.load('run-test')).toHaveLength(1);
    expect(deps.emitter.all().map((e) => e.type)).toEqual(['agent_started', 'agent_complete']);
  });

  it('returns the validated object for a schema call', async () => {
    const deps = await makeDeps(
      scriptedAdapter([toolCallResponse('structured_output', { name: 'ada' }), textResponse('done')]),
    );
    const result = await runAgentCall('produce', { schema: {
      type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
    } }, deps);
    expect(result).toEqual({ name: 'ada' });
  });

  it('replays a cached result on resume without calling the adapter', async () => {
    const throwingAdapter = mockAdapter({ onCall: () => { throw new Error('must not call'); } });
    const deps = await makeDeps(throwingAdapter);
    // Pre-seed resume entry: index 0 with the matching hash for ('say hi', {}).
    const { hashCall } = await import('../../src/workflow/journal.ts');
    deps.resumeEntries = [{ index: 0, hash: hashCall('say hi', {}), result: 'cached!' }];
    const result = await runAgentCall('say hi', undefined, deps);
    expect(result).toBe('cached!');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/workflow/agentcall.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `agentcall.ts`**

```ts
// src/workflow/agentcall.ts
import { agent } from 'flint';
import type { ProviderAdapter } from 'flint';
import type { Budget } from 'flint/budget';
import { standardTools } from '../tools/index.ts';
import type { AgentCounter, Semaphore } from './concurrency.ts';
import type { WorkflowBudget } from './budget.ts';
import { WorkflowError } from './errors.ts';
import type { EventEmitter } from './events.ts';
import { hashCall } from './journal.ts';
import type { JournalEntry, JournalStore } from './journal.ts';
import type { IsolationBackend } from './isolation.ts';
import type { AgentTypeRegistry, WorkflowRegistry } from './registry.ts';
import { makeStructuredOutput } from './schema.ts';
import type { AgentOpts, Models } from './types.ts';

export type RunDeps = {
  adapter: ProviderAdapter;
  models: Models;
  flintBudget: Budget;
  wfBudget: WorkflowBudget;
  semaphore: Semaphore;
  counter: AgentCounter;
  registry: AgentTypeRegistry;
  workflows: WorkflowRegistry | undefined;
  isolation: IsolationBackend;
  worktreeIsolation: IsolationBackend | undefined;
  emitter: EventEmitter;
  journal: JournalStore;
  runId: string;
  resumeEntries: JournalEntry[];
  signal: AbortSignal | undefined;
  args: unknown;
  depth: number;
  nextIndex: () => number;
  currentPhase: { value: string | undefined };
};

export function deriveLabel(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0] ?? prompt;
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
}

export async function runAgentCall(
  prompt: string,
  opts: AgentOpts | undefined,
  deps: RunDeps,
): Promise<unknown> {
  const index = deps.nextIndex();
  const hash = hashCall(prompt, opts ?? {});

  // Resume: replay a cached result when this call's signature is unchanged.
  const cached = deps.resumeEntries.find((e) => e.index === index);
  if (cached !== undefined && cached.hash === hash) {
    return cached.result;
  }

  // Token-target ceiling.
  if (deps.wfBudget.total !== null && deps.wfBudget.remaining() <= 0) {
    throw new WorkflowError(`Workflow token target (${deps.wfBudget.total}) reached`, 'workflow.budget');
  }

  deps.counter.increment();
  const release = await deps.semaphore.acquire();

  const label = opts?.label ?? deriveLabel(prompt);
  const phase = opts?.phase;
  const agentType = opts?.agentType ?? 'default';
  const preset = deps.registry.resolve(agentType);
  const model = opts?.model ?? preset.model ?? deps.models.default;
  const backend =
    opts?.isolation === 'worktree' && deps.worktreeIsolation !== undefined
      ? deps.worktreeIsolation
      : deps.isolation;
  const lease = await backend.acquire(label);

  deps.emitter.emit({
    type: 'agent_started',
    label,
    ...(phase !== undefined ? { phase } : {}),
    agentType,
    model,
  });

  try {
    const baseTools = preset.tools ? preset.tools(lease.workDir) : standardTools(lease.workDir);
    let result: unknown;
    let tokens = 0;

    if (opts?.schema !== undefined) {
      const so = makeStructuredOutput(opts.schema);
      const systemPrompt =
        `${preset.systemPrompt}\n\nYou MUST call the structured_output tool exactly once with your ` +
        'final result as JSON matching the required schema. Do not finish until you have called it.';
      const out = await agent({
        adapter: deps.adapter,
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        tools: [so.tool, ...baseTools],
        budget: deps.flintBudget,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      if (!out.ok) throw out.error;
      deps.wfBudget.record(out.value.usage);
      tokens = out.value.usage.input + out.value.usage.output;
      const value = so.getValue();
      if (value === undefined) {
        throw new WorkflowError(
          `Agent '${label}' finished without producing structured output`,
          'workflow.no_output',
        );
      }
      result = value;
    } else {
      const out = await agent({
        adapter: deps.adapter,
        model,
        messages: [
          { role: 'system', content: preset.systemPrompt },
          { role: 'user', content: prompt },
        ],
        tools: baseTools,
        budget: deps.flintBudget,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      if (!out.ok) throw out.error;
      deps.wfBudget.record(out.value.usage);
      tokens = out.value.usage.input + out.value.usage.output;
      result = out.value.message.content;
    }

    deps.emitter.emit({
      type: 'agent_complete',
      label,
      ...(phase !== undefined ? { phase } : {}),
      tokens,
    });
    await deps.journal.append(deps.runId, { index, hash, result });
    return result;
  } catch (e) {
    deps.emitter.emit({
      type: 'agent_error',
      label,
      ...(phase !== undefined ? { phase } : {}),
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  } finally {
    await lease.release();
    release();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/workflow/agentcall.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add packages/landlord/src/workflow/agentcall.ts packages/landlord/test/workflow/agentcall.test.ts
git commit -m "feat(landlord): agent() hook with schema, isolation, journaling"
```

---

## Task 10: The workflow context (`buildContext`)

**Files:**
- Create: `packages/landlord/src/workflow/hooks.ts`
- Test: `packages/landlord/test/workflow/hooks.test.ts`

**Context:** `buildContext` assembles the `WorkflowContext`. The nested `workflow()` implementation is injected by the runtime (Task 13) as `workflowFn` to avoid a hooks↔runtime import cycle.

- [ ] **Step 1: Write the failing test**

```ts
// test/workflow/hooks.test.ts
import { describe, expect, it } from 'vitest';
import { WorkflowBudget } from '../../src/workflow/budget.ts';
import { EventEmitter } from '../../src/workflow/events.ts';
import { buildContext } from '../../src/workflow/hooks.ts';
import type { RunDeps } from '../../src/workflow/agentcall.ts';

function fakeDeps(): RunDeps {
  return {
    emitter: new EventEmitter(),
    wfBudget: new WorkflowBudget(100),
    args: { topic: 'x' },
    currentPhase: { value: undefined },
    // unused-by-these-tests fields:
  } as unknown as RunDeps;
}

describe('buildContext combinators', () => {
  it('parallel maps a throwing thunk to null', async () => {
    const ctx = buildContext(fakeDeps(), async () => null);
    const out = await ctx.parallel([
      async () => 1,
      async () => {
        throw new Error('x');
      },
    ]);
    expect(out).toEqual([1, null]);
  });

  it('pipeline runs stages per item and drops a throwing item to null', async () => {
    const ctx = buildContext(fakeDeps(), async () => null);
    const out = await ctx.pipeline(
      [1, 2],
      (prev) => (prev as number) + 1,
      (prev, original, i) => {
        if (original === 2) throw new Error('boom');
        return `${prev}@${i}`;
      },
    );
    expect(out).toEqual(['2@0', null]);
  });

  it('phase and log emit events; budget and args are exposed', async () => {
    const deps = fakeDeps();
    const ctx = buildContext(deps, async () => null);
    ctx.phase('Find');
    ctx.log('looking');
    expect(deps.emitter.all().map((e) => e.type)).toEqual(['phase_started', 'log']);
    expect(ctx.budget.total).toBe(100);
    expect(ctx.args).toEqual({ topic: 'x' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/workflow/hooks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `hooks.ts`**

```ts
// src/workflow/hooks.ts
import { runAgentCall } from './agentcall.ts';
import type { RunDeps } from './agentcall.ts';
import { budgetView } from './budget.ts';
import type { AgentOpts, StageFn, WorkflowContext } from './types.ts';

export function buildContext(
  deps: RunDeps,
  workflowFn: WorkflowContext['workflow'],
): WorkflowContext {
  const agent = (prompt: string, opts?: AgentOpts): Promise<unknown> => {
    const phase = opts?.phase ?? deps.currentPhase.value;
    const merged: AgentOpts = { ...(opts ?? {}), ...(phase !== undefined ? { phase } : {}) };
    return runAgentCall(prompt, merged, deps);
  };

  const parallel = async <T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> =>
    Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk();
        } catch {
          return null;
        }
      }),
    );

  const pipeline = async (items: unknown[], ...stages: StageFn[]): Promise<unknown[]> =>
    Promise.all(
      items.map(async (item, index) => {
        let acc: unknown = item;
        for (const stage of stages) {
          try {
            acc = await stage(acc, item, index);
          } catch {
            return null;
          }
        }
        return acc;
      }),
    );

  const phase = (title: string): void => {
    deps.currentPhase.value = title;
    deps.emitter.emit({ type: 'phase_started', title });
  };

  const log = (message: string): void => {
    deps.emitter.emit({ type: 'log', message });
  };

  return {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    args: deps.args,
    budget: budgetView(deps.wfBudget),
    workflow: workflowFn,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/workflow/hooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/landlord/src/workflow/hooks.ts packages/landlord/test/workflow/hooks.test.ts
git commit -m "feat(landlord): workflow context (parallel/pipeline/phase/log)"
```

---

## Task 11: Meta parser + determinism sandbox

**Files:**
- Create: `packages/landlord/src/workflow/meta.ts`
- Create: `packages/landlord/src/workflow/sandbox.ts`
- Test: `packages/landlord/test/workflow/meta.test.ts`
- Test: `packages/landlord/test/workflow/sandbox.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/workflow/meta.test.ts
import { describe, expect, it } from 'vitest';
import { MetaError } from '../../src/workflow/errors.ts';
import { parseMeta } from '../../src/workflow/meta.ts';

describe('parseMeta', () => {
  it('parses a pure object literal with nested arrays', () => {
    const meta = parseMeta(
      `export const meta = { name: 'rev', description: "Review", phases: [{ title: 'A' }, { title: 'B', detail: 'x' }] }\nphase('A')`,
    );
    expect(meta.name).toBe('rev');
    expect(meta.description).toBe('Review');
    expect(meta.phases).toEqual([{ title: 'A' }, { title: 'B', detail: 'x' }]);
  });

  it('rejects a non-literal value (function call) in meta', () => {
    expect(() => parseMeta(`export const meta = { name: foo(), description: 'x' }`)).toThrow(MetaError);
  });

  it('rejects meta missing name/description', () => {
    expect(() => parseMeta(`export const meta = { name: 'x' }`)).toThrow(MetaError);
  });
});
```

```ts
// test/workflow/sandbox.test.ts
import { describe, expect, it } from 'vitest';
import { sandboxBindings } from '../../src/workflow/sandbox.ts';

describe('sandboxBindings', () => {
  it('blocks Date, Math.random, and process but allows pure Math', () => {
    const b = sandboxBindings();
    const D = b['Date'] as { now: () => number };
    const M = b['Math'] as Math;
    const P = b['process'] as { cwd: () => string };
    expect(() => D.now()).toThrow();
    expect(() => new (b['Date'] as unknown as new () => unknown)()).toThrow();
    expect(() => M.random()).toThrow();
    expect(M.floor(3.7)).toBe(3);
    expect(() => P.cwd()).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/workflow/meta.test.ts test/workflow/sandbox.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `meta.ts`**

```ts
// src/workflow/meta.ts
import { MetaError } from './errors.ts';
import type { Meta } from './types.ts';

function skipWs(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') i++;
    else break;
  }
  return i;
}

function parseString(s: string, i: number): { value: string; end: number } {
  const quote = s[i];
  i++;
  let out = '';
  while (i < s.length && s[i] !== quote) {
    if (s[i] === '\\') {
      const n = s[i + 1];
      out +=
        n === 'n' ? '\n'
        : n === 't' ? '\t'
        : n === 'r' ? '\r'
        : n === '\\' ? '\\'
        : n === quote ? quote
        : (n ?? '');
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }
  if (s[i] !== quote) throw new MetaError('Unterminated string in meta literal');
  return { value: out, end: i + 1 };
}

function parseNumber(s: string, i: number): { value: number; end: number } {
  const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
  if (!m) throw new MetaError('Invalid number in meta literal');
  return { value: Number(m[0]), end: i + m[0].length };
}

function parseKey(s: string, i: number): { value: string; end: number } {
  const c = s[i];
  if (c === '"' || c === "'") return parseString(s, i);
  const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
  if (!m) throw new MetaError(`Invalid object key at index ${i}`);
  return { value: m[0], end: i + m[0].length };
}

export function parseLiteral(s: string, start = 0): { value: unknown; end: number } {
  const i = skipWs(s, start);
  const ch = s[i];
  if (ch === '{') {
    let j = skipWs(s, i + 1);
    const obj: Record<string, unknown> = {};
    if (s[j] === '}') return { value: obj, end: j + 1 };
    while (j < s.length) {
      j = skipWs(s, j);
      const key = parseKey(s, j);
      j = skipWs(s, key.end);
      if (s[j] !== ':') throw new MetaError(`Expected ':' at index ${j}`);
      const val = parseLiteral(s, j + 1);
      obj[key.value] = val.value;
      j = skipWs(s, val.end);
      if (s[j] === ',') {
        j = skipWs(s, j + 1);
        if (s[j] === '}') return { value: obj, end: j + 1 };
        continue;
      }
      if (s[j] === '}') return { value: obj, end: j + 1 };
      throw new MetaError(`Expected ',' or '}' at index ${j}`);
    }
    throw new MetaError('Unterminated object in meta literal');
  }
  if (ch === '[') {
    let j = skipWs(s, i + 1);
    const arr: unknown[] = [];
    if (s[j] === ']') return { value: arr, end: j + 1 };
    while (j < s.length) {
      const val = parseLiteral(s, j);
      arr.push(val.value);
      j = skipWs(s, val.end);
      if (s[j] === ',') {
        j = skipWs(s, j + 1);
        if (s[j] === ']') return { value: arr, end: j + 1 };
        continue;
      }
      if (s[j] === ']') return { value: arr, end: j + 1 };
      throw new MetaError(`Expected ',' or ']' at index ${j}`);
    }
    throw new MetaError('Unterminated array in meta literal');
  }
  if (ch === '"' || ch === "'") return parseString(s, i);
  if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) return parseNumber(s, i);
  if (s.startsWith('true', i)) return { value: true, end: i + 4 };
  if (s.startsWith('false', i)) return { value: false, end: i + 5 };
  if (s.startsWith('null', i)) return { value: null, end: i + 4 };
  throw new MetaError(`Unexpected token in meta literal at index ${i}: '${s.slice(i, i + 12)}'`);
}

export function parseMeta(source: string): Meta {
  const m = /export\s+const\s+meta\s*=/.exec(source);
  if (!m) throw new MetaError('Script is missing `export const meta = { ... }`');
  const { value } = parseLiteral(source, m.index + m[0].length);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MetaError('meta must be an object literal');
  }
  const meta = value as Record<string, unknown>;
  if (typeof meta['name'] !== 'string' || typeof meta['description'] !== 'string') {
    throw new MetaError('meta requires string `name` and `description`');
  }
  return meta as unknown as Meta;
}
```

- [ ] **Step 4: Write `sandbox.ts`**

```ts
// src/workflow/sandbox.ts
import { WorkflowError } from './errors.ts';

function forbidden(name: string): never {
  throw new WorkflowError(
    `${name} is not available inside a workflow script (nondeterministic or host access)`,
    'workflow.sandbox',
  );
}

function blockedCallable(name: string): unknown {
  const fn = (): never => forbidden(name);
  return new Proxy(fn, {
    apply: () => forbidden(name),
    construct: () => forbidden(name),
    get: (_t, prop) => {
      if (prop === 'prototype') return undefined;
      return () => forbidden(name);
    },
  });
}

export function sandboxBindings(): Record<string, unknown> {
  const safeMath = new Proxy(Math, {
    get: (target, prop) => {
      if (prop === 'random') return () => forbidden('Math.random');
      return Reflect.get(target, prop);
    },
  });
  return {
    Date: blockedCallable('Date'),
    Math: safeMath,
    process: blockedCallable('process'),
    require: blockedCallable('require'),
    globalThis: blockedCallable('globalThis'),
    global: blockedCallable('global'),
    fs: blockedCallable('fs'),
    eval: blockedCallable('eval'),
    Function: blockedCallable('Function'),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run test/workflow/meta.test.ts test/workflow/sandbox.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/landlord/src/workflow/meta.ts packages/landlord/src/workflow/sandbox.ts packages/landlord/test/workflow/meta.test.ts packages/landlord/test/workflow/sandbox.test.ts
git commit -m "feat(landlord): meta literal parser and determinism sandbox"
```

---

## Task 12: Script compiler + typed authoring

**Files:**
- Create: `packages/landlord/src/workflow/script.ts`
- Create: `packages/landlord/src/workflow/define.ts`
- Test: `packages/landlord/test/workflow/script.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/workflow/script.test.ts
import { describe, expect, it } from 'vitest';
import { compileScript } from '../../src/workflow/script.ts';
import { defineWorkflow } from '../../src/workflow/define.ts';
import { MetaError } from '../../src/workflow/errors.ts';
import type { WorkflowContext } from '../../src/workflow/types.ts';

function fakeCtx(calls: string[]): WorkflowContext {
  return {
    agent: async (p) => {
      calls.push(`agent:${p}`);
      return 'R';
    },
    parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    pipeline: async (items) => items,
    phase: () => {},
    log: (m) => calls.push(`log:${m}`),
    args: { n: 2 },
    budget: { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY },
    workflow: async () => null,
  };
}

describe('compileScript', () => {
  it('parses meta, injects hooks, supports top-level await and return', async () => {
    const mod = compileScript(
      `export const meta = { name: 'x', description: 'y' }\nlog('hi')\nconst r = await agent('do ' + args.n)\nreturn r`,
    );
    expect(mod.meta.name).toBe('x');
    const calls: string[] = [];
    const result = await mod.run(fakeCtx(calls));
    expect(result).toBe('R');
    expect(calls).toEqual(['log:hi', 'agent:do 2']);
  });

  it('blocks nondeterministic globals at runtime', async () => {
    const mod = compileScript(`export const meta = { name: 'a', description: 'b' }\nreturn Date.now()`);
    await expect(mod.run(fakeCtx([]))).rejects.toThrow();
  });
});

describe('defineWorkflow', () => {
  it('returns the module and validates meta', () => {
    const mod = defineWorkflow({ meta: { name: 'm', description: 'd' }, run: async () => 42 });
    expect(mod.meta.name).toBe('m');
    expect(() => defineWorkflow({ meta: { name: 'm' } as never, run: async () => 1 })).toThrow(MetaError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/workflow/script.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `script.ts`**

```ts
// src/workflow/script.ts
import { parseMeta } from './meta.ts';
import { sandboxBindings } from './sandbox.ts';
import type { WorkflowContext, WorkflowModule } from './types.ts';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

export function stripModuleSyntax(source: string): string {
  let body = source.replace(/export\s+const\s+meta\s*=/, 'const __meta__ =');
  body = body.replace(/^\s*import\s.*$/gm, '');
  body = body.replace(/export\s+default\s+/g, 'return ');
  body = body.replace(/export\s+(const|let|var|function|class)\s/g, '$1 ');
  return body;
}

export function compileScript(source: string): WorkflowModule {
  const meta = parseMeta(source);
  const body = stripModuleSyntax(source);
  const sandbox = sandboxBindings();
  const sandboxNames = Object.keys(sandbox);
  const sandboxValues = sandboxNames.map((n) => sandbox[n]);
  const hookNames = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow'];
  const fn = new AsyncFunction(...hookNames, ...sandboxNames, `'use strict';\n${body}`);
  const run = (wf: WorkflowContext): Promise<unknown> =>
    fn(
      wf.agent,
      wf.parallel,
      wf.pipeline,
      wf.phase,
      wf.log,
      wf.args,
      wf.budget,
      wf.workflow,
      ...sandboxValues,
    );
  return { meta, run };
}
```

- [ ] **Step 4: Write `define.ts`**

```ts
// src/workflow/define.ts
import { MetaError } from './errors.ts';
import type { WorkflowModule } from './types.ts';

export function defineWorkflow(def: WorkflowModule): WorkflowModule {
  if (
    def.meta === undefined ||
    typeof def.meta.name !== 'string' ||
    typeof def.meta.description !== 'string'
  ) {
    throw new MetaError('defineWorkflow requires meta with string name and description');
  }
  if (typeof def.run !== 'function') {
    throw new MetaError('defineWorkflow requires a run function');
  }
  return def;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/workflow/script.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/landlord/src/workflow/script.ts packages/landlord/src/workflow/define.ts packages/landlord/test/workflow/script.test.ts
git commit -m "feat(landlord): script compiler and typed defineWorkflow"
```

---

## Task 13: The run engine (`runtime.ts`)

**Files:**
- Create: `packages/landlord/src/workflow/runtime.ts`
- Test: `packages/landlord/test/workflow/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/workflow/runtime.test.ts
import type { NormalizedResponse } from 'flint';
import { mockAdapter, scriptedAdapter } from 'flint/testing';
import { describe, expect, it } from 'vitest';
import { memoryJournalStore } from '../../src/workflow/journal.ts';
import { runWorkflow, runWorkflowScript } from '../../src/workflow/runtime.ts';
import { defineWorkflow } from '../../src/workflow/define.ts';

function textResponse(content: string): NormalizedResponse {
  return { message: { role: 'assistant', content }, usage: { input: 10, output: 5 }, stopReason: 'end' };
}

describe('runWorkflow', () => {
  it('runs a single-agent script and reports events', async () => {
    const adapter = scriptedAdapter([textResponse('hello')]);
    const res = await runWorkflowScript(
      `export const meta = { name: 'r', description: 'd' }\nreturn await agent('hi')`,
      { adapter, models: { default: 'm' } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.result).toBe('hello');
      expect(res.value.events.map((e) => e.type)).toContain('workflow_complete');
    }
  });

  it('replays from a prior run without calling the adapter (resume)', async () => {
    const journal = memoryJournalStore();
    const source = `export const meta = { name: 'r', description: 'd' }\nreturn await agent('hi')`;
    const r1 = await runWorkflowScript(source, {
      adapter: scriptedAdapter([textResponse('hello')]),
      models: { default: 'm' },
      journal,
      runId: 'run1',
    });
    expect(r1.ok && r1.value.result).toBe('hello');

    const throwing = mockAdapter({ onCall: () => { throw new Error('must not be called'); } });
    const r2 = await runWorkflowScript(source, {
      adapter: throwing,
      models: { default: 'm' },
      journal,
      runId: 'run2',
      resumeFromRunId: 'run1',
    });
    expect(r2.ok && r2.value.result).toBe('hello');
  });

  it('runs a typed workflow via runWorkflow', async () => {
    const mod = defineWorkflow({
      meta: { name: 't', description: 'd' },
      run: async (wf) => {
        wf.phase('Work');
        return wf.budget.total;
      },
    });
    const res = await runWorkflow(mod, {
      adapter: scriptedAdapter([]),
      models: { default: 'm' },
      tokenTarget: 500,
    });
    expect(res.ok && res.value.result).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/workflow/runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `runtime.ts`**

```ts
// src/workflow/runtime.ts
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, Result } from 'flint';
import { budget as makeBudget } from 'flint/budget';
import type { Budget } from 'flint/budget';
import type { RunDeps } from './agentcall.ts';
import { WorkflowBudget } from './budget.ts';
import { AgentCounter, Semaphore, defaultConcurrency } from './concurrency.ts';
import { WorkflowError } from './errors.ts';
import { EventEmitter } from './events.ts';
import type { EventSink } from './events.ts';
import { buildContext } from './hooks.ts';
import { gitWorktreeIsolation, workdirIsolation } from './isolation.ts';
import type { IsolationBackend } from './isolation.ts';
import { memoryJournalStore } from './journal.ts';
import type { JournalStore } from './journal.ts';
import { createAgentRegistry } from './registry.ts';
import type { AgentTypeRegistry, WorkflowRegistry } from './registry.ts';
import { compileScript } from './script.ts';
import type {
  Models,
  WorkflowContext,
  WorkflowModule,
  WorkflowRunResult,
} from './types.ts';

export type RuntimeConfig = {
  adapter: ProviderAdapter;
  models: Models;
  args?: unknown;
  budget?: Budget;
  tokenTarget?: number | null;
  registry?: AgentTypeRegistry;
  workflows?: WorkflowRegistry;
  journal?: JournalStore;
  isolation?: IsolationBackend;
  worktreeRepoDir?: string;
  baseDir?: string;
  concurrency?: number;
  agentCap?: number;
  onEvent?: EventSink;
  signal?: AbortSignal;
  runId?: string;
  resumeFromRunId?: string;
};

async function buildDeps(config: RuntimeConfig): Promise<RunDeps> {
  const runId = config.runId ?? randomUUID().slice(0, 8);
  const baseDir = config.baseDir ?? join(tmpdir(), `flint-workflow-${runId}`);
  await mkdir(baseDir, { recursive: true });
  const journal = config.journal ?? memoryJournalStore();
  const resumeEntries =
    config.resumeFromRunId !== undefined ? await journal.load(config.resumeFromRunId) : [];
  let index = 0;
  return {
    adapter: config.adapter,
    models: config.models,
    flintBudget: config.budget ?? makeBudget({ maxSteps: 1_000_000 }),
    wfBudget: new WorkflowBudget(config.tokenTarget ?? null),
    semaphore: new Semaphore(config.concurrency ?? defaultConcurrency()),
    counter: new AgentCounter(config.agentCap ?? 1000),
    registry: config.registry ?? createAgentRegistry(),
    workflows: config.workflows,
    isolation: config.isolation ?? workdirIsolation(baseDir),
    worktreeIsolation:
      config.worktreeRepoDir !== undefined
        ? gitWorktreeIsolation(config.worktreeRepoDir, baseDir)
        : undefined,
    emitter: new EventEmitter(config.onEvent),
    journal,
    runId,
    resumeEntries,
    signal: config.signal,
    args: config.args,
    depth: 0,
    nextIndex: () => index++,
    currentPhase: { value: undefined },
  };
}

function resolveSource(
  ref: string | { scriptPath?: string; source?: string },
  workflows: WorkflowRegistry | undefined,
): string {
  if (typeof ref === 'string') {
    const src = workflows?.resolve(ref);
    if (src === undefined) throw new WorkflowError(`Unknown workflow '${ref}'`, 'workflow.unknown');
    return src;
  }
  if (ref.source !== undefined) return ref.source;
  throw new WorkflowError(
    'workflow(): provide a registered name or { source }; { scriptPath } must be read by the caller.',
    'workflow.unknown',
  );
}

function executeModule(module: WorkflowModule, deps: RunDeps): Promise<unknown> {
  const workflowFn: WorkflowContext['workflow'] = async (ref, childArgs) => {
    if (deps.depth >= 1) {
      throw new WorkflowError('workflow() nesting is one level only', 'workflow.nesting');
    }
    const child = compileScript(resolveSource(ref, deps.workflows));
    return executeModule(child, { ...deps, depth: deps.depth + 1, args: childArgs });
  };
  return module.run(buildContext(deps, workflowFn));
}

export async function runWorkflow(
  module: WorkflowModule,
  config: RuntimeConfig,
): Promise<Result<WorkflowRunResult>> {
  const deps = await buildDeps(config);
  try {
    const result = await executeModule(module, deps);
    deps.emitter.emit({ type: 'workflow_complete', result });
    return { ok: true, value: { runId: deps.runId, result, events: deps.emitter.all() } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

export async function runWorkflowScript(
  source: string,
  config: RuntimeConfig,
): Promise<Result<WorkflowRunResult>> {
  let module: WorkflowModule;
  try {
    module = compileScript(source);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }
  return runWorkflow(module, config);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/workflow/runtime.test.ts && pnpm typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/landlord/src/workflow/runtime.ts packages/landlord/test/workflow/runtime.test.ts
git commit -m "feat(landlord): workflow run engine with resume and nesting"
```

## Task 14: Model-facing `workflowTool` + guide

**Files:**
- Create: `packages/landlord/src/workflow/tool.ts`
- Test: `packages/landlord/test/workflow/tool.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/workflow/tool.test.ts
import type { NormalizedResponse } from 'flint';
import { execute } from 'flint';
import { scriptedAdapter } from 'flint/testing';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_TOOL_GUIDE, workflowTool } from '../../src/workflow/tool.ts';

function textResponse(content: string): NormalizedResponse {
  return { message: { role: 'assistant', content }, usage: { input: 10, output: 5 }, stopReason: 'end' };
}

describe('workflowTool', () => {
  it('runs a script supplied as tool input and returns runId + result', async () => {
    const adapter = scriptedAdapter([textResponse('inner-result')]);
    const tool = workflowTool({ adapter, models: { default: 'm' } });
    const res = await execute(tool, {
      script: `export const meta = { name: 'x', description: 'y' }\nreturn await agent('go')`,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const parsed = JSON.parse(res.value as string);
      expect(parsed.result).toBe('inner-result');
      expect(typeof parsed.runId).toBe('string');
    }
  });

  it('errors clearly when neither script nor name is provided', async () => {
    const tool = workflowTool({ adapter: scriptedAdapter([]), models: { default: 'm' } });
    const res = await execute(tool, {});
    expect(res.ok).toBe(true);
    expect(String(res.ok ? res.value : '')).toMatch(/provide either/i);
  });
});

describe('WORKFLOW_TOOL_GUIDE', () => {
  it('documents the core hooks', () => {
    expect(WORKFLOW_TOOL_GUIDE).toMatch(/pipeline/);
    expect(WORKFLOW_TOOL_GUIDE).toMatch(/parallel/);
    expect(WORKFLOW_TOOL_GUIDE).toMatch(/schema/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/workflow/tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `tool.ts`**

```ts
// src/workflow/tool.ts
import { agent, tool } from 'flint';
import type { ProviderAdapter, Result, Tool } from 'flint';
import { budget as makeBudget } from 'flint/budget';
import type { Budget } from 'flint/budget';
import { z } from 'zod';
import type { EventSink } from './events.ts';
import type { IsolationBackend } from './isolation.ts';
import type { JournalStore } from './journal.ts';
import type { AgentTypeRegistry, WorkflowRegistry } from './registry.ts';
import { runWorkflowScript } from './runtime.ts';
import type { RuntimeConfig } from './runtime.ts';
import type { Models } from './types.ts';

export type WorkflowToolConfig = {
  adapter: ProviderAdapter;
  models: Models;
  registry?: AgentTypeRegistry;
  workflows?: WorkflowRegistry;
  journal?: JournalStore;
  isolation?: IsolationBackend;
  onEvent?: EventSink;
};

const workflowToolSchema = z.object({
  script: z.string().optional(),
  args: z.unknown().optional(),
  name: z.string().optional(),
  resumeFromRunId: z.string().optional(),
});

const WORKFLOW_TOOL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    script: {
      type: 'string',
      description: 'A workflow JS script beginning with `export const meta = { ... }`.',
    },
    args: { description: 'Optional value exposed to the script as `args`.' },
    name: { type: 'string', description: 'Name of a registered workflow to run instead of `script`.' },
    resumeFromRunId: { type: 'string', description: 'Resume a prior run, replaying unchanged agents.' },
  },
};

export function workflowTool(config: WorkflowToolConfig): Tool {
  return tool({
    name: 'workflow',
    description:
      'Author and run a dynamic multi-agent workflow. Provide a `script` that orchestrates ' +
      'subagents with agent()/parallel()/pipeline()/phase()/log()/budget()/workflow(). ' +
      'Returns JSON { runId, result }.',
    input: workflowToolSchema,
    jsonSchema: WORKFLOW_TOOL_JSON_SCHEMA,
    handler: async (input) => {
      let source = input.script;
      if (source === undefined && input.name !== undefined) {
        source = config.workflows?.resolve(input.name);
      }
      if (source === undefined) {
        return 'Error: provide either a `script` string or a registered `name`.';
      }
      const runtimeConfig: RuntimeConfig = {
        adapter: config.adapter,
        models: config.models,
        ...(config.registry !== undefined ? { registry: config.registry } : {}),
        ...(config.workflows !== undefined ? { workflows: config.workflows } : {}),
        ...(config.journal !== undefined ? { journal: config.journal } : {}),
        ...(config.isolation !== undefined ? { isolation: config.isolation } : {}),
        ...(config.onEvent !== undefined ? { onEvent: config.onEvent } : {}),
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.resumeFromRunId !== undefined ? { resumeFromRunId: input.resumeFromRunId } : {}),
      };
      const res = await runWorkflowScript(source, runtimeConfig);
      if (!res.ok) return `Error: ${res.error.message}`;
      return JSON.stringify({ runId: res.value.runId, result: res.value.result });
    },
  }) as unknown as Tool;
}

export function orchestratorAgent(config: WorkflowToolConfig) {
  const wt = workflowTool(config);
  return (prompt: string, opts?: { budget?: Budget; model?: string }): ReturnType<typeof agent> =>
    agent({
      adapter: config.adapter,
      model: opts?.model ?? config.models.default,
      messages: [
        { role: 'system', content: WORKFLOW_TOOL_GUIDE },
        { role: 'user', content: prompt },
      ],
      tools: [wt],
      budget: opts?.budget ?? makeBudget({ maxSteps: 50 }),
    });
}

export const WORKFLOW_TOOL_GUIDE = `You can orchestrate subagents by writing a workflow script and running it with the \`workflow\` tool.

A script begins with a pure-literal meta block, then a body using injected hooks:

  export const meta = { name: 'review', description: 'Review changes and verify findings' }
  phase('Find')
  const findings = await parallel(FINDERS.map(f => () => agent(f.prompt, { schema: FINDINGS })))
  return findings.flat().filter(Boolean)

Hooks available in the script:
- agent(prompt, opts?) — spawn a subagent. Without a schema it returns the agent's final text; with { schema } (a JSON Schema) it is forced to return a validated object. opts: { label, phase, schema, model, isolation: 'worktree', agentType }.
- parallel(thunks) — run thunks concurrently. This is a BARRIER: it awaits all of them. A thunk that throws becomes null in the result array, so filter(Boolean) before use.
- pipeline(items, ...stages) — run each item through every stage independently, with NO barrier between stages. Each stage receives (prevResult, originalItem, index). A throwing stage drops that item to null. This is the DEFAULT for multi-stage work.
- phase(title) / log(message) — progress grouping and narration.
- args — the input value passed to the run.
- budget — { total, spent(), remaining() } in output tokens; total may be null. Use for loops: while (budget.total && budget.remaining() > 50000) { ... }.
- workflow(nameOrRef, args?) — run another registered workflow inline (one level only).

Determinism: Date.now(), new Date(), and Math.random() are unavailable inside scripts (they throw) so runs can be resumed. Pass timestamps via args; vary by index for pseudo-randomness.

Concurrency is capped automatically; the total number of agents per run is capped at 1000.

Default to pipeline() — only use a barrier (parallel between stages) when stage N genuinely needs all of stage N-1's results at once (dedup/merge, early-exit on zero, cross-item comparison).

Quality patterns to compose as the task warrants:
- Adversarial verify: spawn independent skeptics per finding, each prompted to REFUTE; keep only findings that survive a majority.
- Judge panel: generate N independent attempts from different angles, score with parallel judges, synthesize from the winner.
- Loop-until-dry: keep spawning finders until K consecutive rounds surface nothing new.
- Multi-modal sweep: parallel agents each searching a different way; each blind to the others.
- Completeness critic: a final agent that asks "what's missing?" — its answer becomes the next round of work.

Scale effort to the request: a quick check needs a few agents and single-vote verification; "thoroughly audit this" warrants a larger finder pool plus a 3–5 vote adversarial pass and a synthesis stage.`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/workflow/tool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/landlord/src/workflow/tool.ts packages/landlord/test/workflow/tool.test.ts
git commit -m "feat(landlord): workflowTool, orchestratorAgent, and tool guide"
```

---

## Task 15: Wiring + `orchestrate()` rebuilt on the runtime

**Files:**
- Create: `packages/landlord/src/workflow/index.ts`
- Modify: `packages/landlord/src/orchestrate.ts` (full rewrite of the `orchestrate()` function; helpers/types unchanged)
- Modify: `packages/landlord/src/index.ts`
- Modify: `packages/landlord/package.json`
- Modify: `packages/landlord/tsup.config.ts`

**Backward-compat constraint:** `test/orchestrate.test.ts`, `test/tenant.test.ts`, `test/decompose.test.ts`, `test/validate.test.ts`, and `test/contract.test.ts` must pass **unchanged**. The rewrite keeps `decompose()`, `resolveOrder()`, `DependencyCycleError`, all event names, and the `OrchestrateResult` shape identical; it only moves the tenant scheduling inside a runtime run so tenants share the semaphore/runId.

- [ ] **Step 1: Write `workflow/index.ts`**

```ts
// src/workflow/index.ts
export { runWorkflow, runWorkflowScript } from './runtime.ts';
export type { RuntimeConfig } from './runtime.ts';
export { defineWorkflow } from './define.ts';
export { compileScript, stripModuleSyntax } from './script.ts';
export { parseMeta, parseLiteral } from './meta.ts';
export { sandboxBindings } from './sandbox.ts';
export { workflowTool, orchestratorAgent, WORKFLOW_TOOL_GUIDE } from './tool.ts';
export type { WorkflowToolConfig } from './tool.ts';
export {
  createAgentRegistry,
  createWorkflowRegistry,
  BUILT_IN_AGENT_TYPES,
} from './registry.ts';
export type { AgentType, AgentTypeRegistry, WorkflowRegistry } from './registry.ts';
export { memoryJournalStore, fileJournalStore, hashCall } from './journal.ts';
export type { JournalEntry, JournalStore } from './journal.ts';
export { workdirIsolation, gitWorktreeIsolation } from './isolation.ts';
export type { IsolationBackend, IsolationLease } from './isolation.ts';
export { WorkflowBudget, budgetView } from './budget.ts';
export { Semaphore, AgentCounter, defaultConcurrency } from './concurrency.ts';
export { EventEmitter } from './events.ts';
export type { EventSink } from './events.ts';
export { WorkflowError, AgentCapError, MetaError } from './errors.ts';
export type {
  AgentOpts,
  Meta,
  MetaPhase,
  Models,
  StageFn,
  WorkflowBudgetView,
  WorkflowContext,
  WorkflowEvent,
  WorkflowModule,
  WorkflowRunResult,
} from './types.ts';
```

- [ ] **Step 2: Rewrite `src/orchestrate.ts`**

Replace the entire file with the following. The `DependencyCycleError`, `resolveOrder`, and all exported types are reproduced unchanged; only `orchestrate()` is rebuilt to run inside `runWorkflow`.

```ts
// src/orchestrate.ts
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, Result, Tool } from 'flint';
import type { Budget } from 'flint/budget';
import type { Contract } from './contract.ts';
import { decompose } from './decompose.ts';
import { runTenant } from './tenant.ts';
import { defineWorkflow } from './workflow/define.ts';
import { runWorkflow } from './workflow/runtime.ts';

export class DependencyCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyCycleError';
  }
}

export function resolveOrder(contracts: Contract[]): Contract[] {
  const byRole = new Map(contracts.map((c) => [c.role, c]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(contracts.map((c) => [c.role, WHITE]));
  const order: Contract[] = [];

  function visit(role: string, stack: string[]): void {
    if (color.get(role) === GRAY) {
      throw new DependencyCycleError(`Dependency cycle: ${[...stack, role].join(' -> ')}`);
    }
    if (color.get(role) === BLACK) return;
    const entry = byRole.get(role);
    if (!entry) return;
    color.set(role, GRAY);
    for (const dep of entry.dependsOn) {
      visit(dep, [...stack, role]);
    }
    color.set(role, BLACK);
    order.push(entry);
  }

  for (const c of contracts) visit(c.role, []);
  return order;
}

export type TenantOutcome =
  | { status: 'complete'; artifacts: Record<string, unknown> }
  | { status: 'escalated'; lastError: string; retriesExhausted: number };

export type OrchestrateResult = {
  status: 'complete' | 'partial';
  tenants: Record<string, TenantOutcome>;
  artifacts: Record<string, Record<string, unknown>>;
};

export type LandlordEvent =
  | { type: 'tenant_started'; role: string }
  | { type: 'checkpoint_passed'; role: string; checkpoint: string }
  | { type: 'checkpoint_failed'; role: string; checkpoint: string; reason: string }
  | { type: 'tenant_complete'; role: string }
  | { type: 'tenant_evicted'; role: string; reason: string; retry: number }
  | { type: 'tenant_escalated'; role: string }
  | { type: 'job_complete'; artifacts: Record<string, Record<string, unknown>> };

export type OrchestratorConfig = {
  adapter: ProviderAdapter;
  landlordModel: string;
  tenantModel: string;
  /** Shared job-level budget consumed by ALL tenants and the landlord decompose call. */
  budget?: Budget;
  outputDir?: string;
  onEvent?: (event: LandlordEvent) => void;
};

export async function orchestrate(
  prompt: string,
  toolsFactory: (workDir: string) => Tool[],
  config: OrchestratorConfig,
): Promise<Result<OrchestrateResult>> {
  const decomposeResult = await decompose(prompt, {
    adapter: config.adapter,
    model: config.landlordModel,
    ...(config.budget !== undefined ? { budget: config.budget } : {}),
  });
  if (!decomposeResult.ok) return decomposeResult;
  const plan = decomposeResult.value;

  try {
    resolveOrder(plan);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }

  const baseOutputDir = config.outputDir ?? join(tmpdir(), `landlord-${Date.now()}`);
  await mkdir(join(baseOutputDir, 'shared'), { recursive: true });

  const module = defineWorkflow({
    meta: { name: 'auto-decompose', description: 'Landlord auto-decomposition orchestration' },
    run: async (wf): Promise<OrchestrateResult> => {
      const gates = new Map<
        string,
        { promise: Promise<Record<string, unknown>>; resolve: (v: Record<string, unknown>) => void }
      >();
      for (const c of plan) {
        let resolve!: (v: Record<string, unknown>) => void;
        const promise = new Promise<Record<string, unknown>>((r) => {
          resolve = r;
        });
        gates.set(c.role, { promise, resolve });
      }

      const escalatedRoles = new Set<string>();
      const tenantOutcomes: Record<string, TenantOutcome> = {};
      const jobArtifacts: Record<string, Record<string, unknown>> = {};

      async function runWithRetry(contract: Contract): Promise<void> {
        for (const dep of contract.dependsOn) {
          await gates.get(dep)?.promise;
          if (escalatedRoles.has(dep)) {
            const lastError = `Dependency '${dep}' escalated before this tenant could start`;
            escalatedRoles.add(contract.role);
            tenantOutcomes[contract.role] = { status: 'escalated', lastError, retriesExhausted: 0 };
            gates.get(contract.role)?.resolve({});
            config.onEvent?.({ type: 'tenant_escalated', role: contract.role });
            return;
          }
        }

        const sharedArtifacts: Record<string, unknown> = {};
        for (const dep of contract.dependsOn) {
          const depArtifacts = jobArtifacts[dep] ?? {};
          for (const [k, v] of Object.entries(depArtifacts)) {
            sharedArtifacts[`${dep}.${k}`] = v;
          }
        }

        const workDir = join(baseOutputDir, contract.role);
        await mkdir(workDir, { recursive: true });
        config.onEvent?.({ type: 'tenant_started', role: contract.role });

        let lastError: string | undefined;
        for (let attempt = 0; attempt < contract.maxRetries; attempt++) {
          const result = await runTenant(
            contract,
            toolsFactory(workDir),
            {
              adapter: config.adapter,
              model: config.tenantModel,
              ...(config.budget !== undefined ? { budget: config.budget } : {}),
              workDir,
            },
            lastError,
            Object.keys(sharedArtifacts).length > 0 ? sharedArtifacts : undefined,
          );

          if (result.ok) {
            jobArtifacts[contract.role] = result.value;
            tenantOutcomes[contract.role] = { status: 'complete', artifacts: result.value };
            gates.get(contract.role)?.resolve(result.value);
            config.onEvent?.({ type: 'tenant_complete', role: contract.role });
            return;
          }

          lastError = result.error.message;
          config.onEvent?.({
            type: 'tenant_evicted',
            role: contract.role,
            reason: lastError,
            retry: attempt + 1,
          });
        }

        escalatedRoles.add(contract.role);
        tenantOutcomes[contract.role] = {
          status: 'escalated',
          lastError: lastError ?? 'unknown',
          retriesExhausted: contract.maxRetries,
        };
        gates.get(contract.role)?.resolve({});
        config.onEvent?.({ type: 'tenant_escalated', role: contract.role });
      }

      await wf.parallel(plan.map((c) => () => runWithRetry(c)));

      const allComplete = Object.values(tenantOutcomes).every((o) => o.status === 'complete');
      const status: 'complete' | 'partial' = allComplete ? 'complete' : 'partial';
      config.onEvent?.({ type: 'job_complete', artifacts: jobArtifacts });
      return { status, tenants: tenantOutcomes, artifacts: jobArtifacts };
    },
  });

  const runResult = await runWorkflow(module, {
    adapter: config.adapter,
    models: { default: config.tenantModel },
    ...(config.budget !== undefined ? { budget: config.budget } : {}),
    baseDir: baseOutputDir,
  });
  if (!runResult.ok) return runResult;
  return { ok: true, value: runResult.value.result as OrchestrateResult };
}
```

- [ ] **Step 3: Update `src/index.ts`**

Add this line at the end of the existing exports (keep all current exports intact):

```ts
export * from './workflow/index.ts';
```

- [ ] **Step 4: Update `package.json` exports**

Add a `./workflow` entry to the `exports` map (after `./tools`):

```json
"./workflow": { "types": "./dist/workflow/index.d.ts", "import": "./dist/workflow/index.js" }
```

- [ ] **Step 5: Update `tsup.config.ts`**

Change the `entry` array to include the workflow entry:

```ts
entry: ['src/index.ts', 'src/tools/index.ts', 'src/workflow/index.ts'],
```

- [ ] **Step 6: Run backward-compat + typecheck + build**

Run: `pnpm typecheck && pnpm vitest run test/orchestrate.test.ts test/tenant.test.ts test/decompose.test.ts test/validate.test.ts test/contract.test.ts && pnpm build`
Expected: typecheck clean; all 5 existing suites PASS; build emits `dist/workflow/index.js`.

- [ ] **Step 7: Commit**

```bash
git add packages/landlord/src/workflow/index.ts packages/landlord/src/orchestrate.ts packages/landlord/src/index.ts packages/landlord/package.json packages/landlord/tsup.config.ts
git commit -m "feat(landlord): rebuild orchestrate on runtime; export workflow surface"
```

---

## Task 16: Docs, changeset, and full verification

**Files:**
- Create: `packages/landlord/README.md` is not required; docs live in `docs/`.
- Create: `docs/landlord/workflow.md`, `docs/landlord/hooks.md`, `docs/landlord/resume.md`, `docs/landlord/agent-types.md`, `docs/landlord/isolation.md`, `docs/landlord/workflow-tool.md`
- Create: `docs/examples/dynamic-workflow.md`
- Modify: `docs/landlord/index.md` (add the workflow-runtime mental model), `docs/landlord/orchestrate.md` (note it is runtime-backed), `docs/.vitepress/config.ts` (sidebar/nav), `README.md` (Landlord bullet)
- Create: `.changeset/landlord-dynamic-workflows.md`

> Docs are prose, not TDD. Write real, runnable TypeScript in every snippet against the API built in Tasks 1–15. Each page ends with a "See also" section (project doc norm). Keep tone developer-to-developer.

- [ ] **Step 1: Write `docs/landlord/workflow.md`**

Cover: the mental model (a workflow is a script/typed function that drives subagents via hooks); a quick start with both `runWorkflowScript()` (string) and `defineWorkflow()` (typed); the full `RuntimeConfig` field table (`adapter`, `models`, `args`, `budget`, `tokenTarget`, `registry`, `workflows`, `journal`, `isolation`, `worktreeRepoDir`, `baseDir`, `concurrency`, `agentCap`, `onEvent`, `signal`, `runId`, `resumeFromRunId`); the `WorkflowEvent` catalog; and a comparison table "workflow runtime vs orchestrate() vs @flint/graph vs agent()". Use the review→verify pipeline as the worked example.

- [ ] **Step 2: Write `docs/landlord/hooks.md`**

Full reference for `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`, with the exact signatures from `src/workflow/types.ts`, the barrier-vs-no-barrier distinction, the `AgentOpts` field table (`label`, `phase`, `schema`, `model`, `isolation`, `agentType`), and the structured-output retry behavior.

- [ ] **Step 3: Write `docs/landlord/resume.md`**

Explain journaling: `JournalStore`, `memoryJournalStore()` vs `fileJournalStore(dir)`, how `resumeFromRunId` replays the longest unchanged prefix, the determinism requirement (sandbox blocks `Date`/`Math.random` in string scripts; typed workflows must avoid nondeterminism), and a runnable resume example.

- [ ] **Step 4: Write `docs/landlord/agent-types.md`**

Document `createAgentRegistry()`, the three built-ins (`default`, `Explore`, `code-reviewer`) with their toolsets and prompts, how `agentType` composes with `schema`, and how to register custom types.

- [ ] **Step 5: Write `docs/landlord/isolation.md`**

Document `IsolationBackend`, `workdirIsolation()` (default, per-agent sandboxed dir), `gitWorktreeIsolation()` (via `worktreeRepoDir`, fallback behavior outside a repo), and when to use `isolation: 'worktree'`.

- [ ] **Step 6: Write `docs/landlord/workflow-tool.md`**

Document `workflowTool()`, `WorkflowToolConfig`, `orchestratorAgent()`, and `WORKFLOW_TOOL_GUIDE` — how to give an `agent()` the ability to author-and-run workflows itself, with a runnable example.

- [ ] **Step 7: Write `docs/examples/dynamic-workflow.md`**

A complete worked example: a review→verify pipeline shown both as a string script and the equivalent `defineWorkflow()`, with `onEvent` logging and the printed result.

- [ ] **Step 8: Update `docs/landlord/index.md`, `docs/landlord/orchestrate.md`, `docs/.vitepress/config.ts`, `README.md`**

- In `index.md`: add a short "Two ways to orchestrate" section — the new script-driven workflow runtime (headline) and the original auto-decompose `orchestrate()` (now a built-in workflow on the runtime).
- In `orchestrate.md`: add a callout that `orchestrate()` now runs on the workflow runtime; behavior and API are unchanged.
- In `config.ts`: add the new pages to the `'/landlord/'` sidebar (`Workflows`, `Hooks`, `Resume`, `Agent Types`, `Isolation`, `Workflow Tool`) and add `Dynamic Workflow` to the examples sidebar.
- In `README.md`: extend the Landlord line in `## Packages` / the docs list to mention "dynamic workflow runtime (ultracode-style script orchestration)".

- [ ] **Step 9: Write the changeset**

```md
// .changeset/landlord-dynamic-workflows.md
---
"landlord": minor
---

Add a dynamic-workflow runtime: author workflows as typed functions (`defineWorkflow`) or model-written JS scripts (`runWorkflowScript`) that orchestrate subagents via `agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`/`workflow` hooks, with structured-output schemas, concurrency/agent caps, resume/journaling, a determinism sandbox, an agent-type registry, isolation backends, and a model-facing `workflowTool`. `orchestrate()` is now built on this runtime (API unchanged).
```

- [ ] **Step 10: Full verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
(from the repo root, or `pnpm -C packages/landlord ...` then root docs build `pnpm docs:build`)
Expected: all workflow + existing suites PASS; typecheck clean; Biome lint clean; build emits all three entries; `pnpm docs:build` succeeds.

- [ ] **Step 11: Commit**

```bash
git add docs/ README.md .changeset/landlord-dynamic-workflows.md
git commit -m "docs(landlord): dynamic-workflow runtime docs, example, and changeset"
```

---

## Self-Review (completed during planning)

**Spec coverage:** every spec section maps to a task — hooks/types (T1, T9, T10), concurrency+caps (T2), budget bridge (T3), events (T4), resume/journaling (T5, T13), agentType registry + built-ins (T6), isolation backends (T7), structured-output schema (T8), determinism sandbox + meta (T11), string+typed authoring (T12), run engine + nesting (T13), workflowTool + guide (T14), orchestrate rebuild + packaging (T15), docs + changeset (T16). The harness-coupled non-goals (TUI tree, background notifications, MCP ToolSearch) are intentionally mapped to `onEvent`/`AbortSignal`/explicit tool passing per spec §13.

**Type consistency:** `RunDeps` is defined once (T9) and consumed by `hooks.ts`/`runtime.ts` via type-only import (no runtime cycle). `WorkflowContext`, `AgentOpts`, `Models`, `Meta` come from `types.ts` (T1) throughout. `makeStructuredOutput` returns `{ tool, getValue }` (T8) used verbatim in T9. `RuntimeConfig.models` is `{ default, … }` and `orchestrate()` maps `tenantModel → models.default` (T15), matching the spec's resolved model order `opts.model ?? preset.model ?? config.models.default` (T9).

**Placeholder scan:** no TBD/TODO; every code step contains complete, compilable code; every run step has an exact command and expected outcome.

**Known risk + mitigation:** the `orchestrate()` rebuild (T15) is the only change to shipped behavior — mitigated by reusing `runTenant`/gates/retry verbatim and gating the task on the five existing suites passing unchanged (T15 Step 6).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-31-landlord-dynamic-workflows.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, two-stage review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session with batch checkpoints for review.

**Which approach?**

