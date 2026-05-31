# Hooks Reference

Every workflow receives a `WorkflowContext` — either as the `wf` parameter of `defineWorkflow`'s `run` function, or as injected globals in a string script. This page documents each hook exactly as it appears in the source.

## Type definitions

```ts
type WorkflowContext = {
  agent(prompt: string, opts?: AgentOpts): Promise<unknown>;
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
  pipeline(items: unknown[], ...stages: StageFn[]): Promise<unknown[]>;
  phase(title: string): void;
  log(message: string): void;
  args: unknown;
  budget: WorkflowBudgetView;
  workflow(
    ref: string | { scriptPath?: string; source?: string },
    args?: unknown,
  ): Promise<unknown>;
};

type AgentOpts = {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  model?: string;
  isolation?: 'worktree';
  agentType?: string;
};

type StageFn = (
  prev: unknown,
  originalItem: unknown,
  index: number,
) => unknown | Promise<unknown>;

type WorkflowBudgetView = {
  total: number | null;
  spent: () => number;
  remaining: () => number;
};
```

---

## `agent(prompt, opts?)`

Spawns a subagent — a full Flint `agent()` loop with an isolated work directory, tools from the resolved `agentType`, and optional structured output.

```ts
// No schema: returns the agent's final assistant text (string)
const summary = await wf.agent('Summarize the codebase in three sentences');

// With schema: agent is forced to call structured_output; returns validated object
const findings = await wf.agent('Review src/auth.ts for security issues', {
  schema: {
    type: 'object',
    properties: {
      issues: { type: 'array', items: { type: 'string' } },
      severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
    required: ['issues', 'severity'],
  },
});
// findings is { issues: string[], severity: string }
```

### AgentOpts

| Field | Type | Description |
|-------|------|-------------|
| `label` | `string` | Display label for this agent in events and logs. Defaults to the first 48 characters of the prompt. |
| `phase` | `string` | Override the progress phase for this agent (avoids races in `parallel`/`pipeline`; the active `wf.phase()` is used otherwise). |
| `schema` | `Record<string, unknown>` | JSON Schema for structured output. The agent is forced to call a `structured_output` tool and the validated result is returned. Retries on schema mismatch. |
| `model` | `string` | Per-agent model override. Wins over the `agentType` preset model and `config.models.default`. |
| `isolation` | `'worktree'` | Select the git-worktree isolation backend for this agent (requires `worktreeRepoDir` in `RuntimeConfig`; falls back to `workdirIsolation` outside a git repo). |
| `agentType` | `string` | Resolve a preset from the `AgentTypeRegistry`. Built-ins: `'default'`, `'Explore'`, `'code-reviewer'`. Composes with `schema`. |

### Structured output retry behavior

When `schema` is set, the runtime appends a forced `structured_output` tool to the agent's tool list. The handler validates the call with ajv. On mismatch, it returns an error message telling the agent which fields are wrong so the agent retries. Only the first valid call is captured; subsequent calls are ignored. A hard `WorkflowError` is thrown if the agent finishes without calling `structured_output` at all.

---

## `parallel(thunks)`

Runs all thunks concurrently and **waits for all of them** (barrier). A thunk that throws resolves to `null` — `parallel` never rejects.

```ts
const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

// All three start simultaneously; parallel waits for all three
const results = await wf.parallel(
  files.map((f) => () => wf.agent(`Summarize ${f}`)),
);
// results: Array<string | null>  — null where an agent threw

const successes = results.filter((r): r is string => r !== null);
```

Use `parallel` when you need a barrier — stage N genuinely needs all of stage N-1's results before proceeding (for dedup, merging, or early-exit on zero results). For independent multi-stage work use `pipeline` instead.

---

## `pipeline(items, ...stages)`

Processes each item through every stage independently with **no barrier between stages**. Wall-clock time equals the slowest single-item chain, not the sum of all stages.

Each stage receives `(prevResult, originalItem, index)`. A throwing stage sets that item's result to `null` and skips its remaining stages. The returned array is aligned to `items`.

```ts
const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

// Stage 1: summarize; Stage 2: grade the summary — each file flows independently
const graded = await wf.pipeline(
  files,
  // stage 1: returns summary string
  (_, file) => wf.agent(`Summarize ${file as string}`),
  // stage 2: receives summary from stage 1, grades it
  (summary, file) =>
    wf.agent(`Grade this summary of ${file as string}: "${summary as string}"`, {
      schema: {
        type: 'object',
        properties: { score: { type: 'number' }, comment: { type: 'string' } },
        required: ['score', 'comment'],
      },
    }),
);
// graded: Array<{ score: number; comment: string } | null>
```

`pipeline` is the default choice for multi-stage work. Only reach for `parallel` when you need a cross-item barrier.

---

## `phase(title)`

Marks the start of a named progress group. Fires a `phase_started` event and updates the ambient phase for subsequent `agent()` calls.

```ts
wf.phase('Research');
// ... agents here get phase: 'Research' in their events

wf.phase('Write');
// ... agents here get phase: 'Write'
```

---

## `log(message)`

Emits a `log` event — a human-readable narrator line for progress reporting.

```ts
wf.log(`Processing ${files.length} files`);
wf.log('All findings verified');
```

---

## `args`

The value passed as `RuntimeConfig.args`. Available verbatim in both string scripts and typed workflows. No type assumption — cast to the expected shape:

```ts
// Typed workflow
const files = wf.args as string[];

// String script
const files = args; // injected as a global
```

---

## `budget`

Exposes the run's token usage against the optional `tokenTarget` ceiling:

```ts
type WorkflowBudgetView = {
  total: number | null;    // tokenTarget, or null when unset
  spent: () => number;     // output tokens used so far this run
  remaining: () => number; // max(0, total - spent()) or Infinity when total is null
};
```

Use `budget` for adaptive loops:

```ts
while (wf.budget.total !== null && wf.budget.remaining() > 50_000) {
  const round = await wf.agent('Find more issues');
  if (!round) break;
  // process round...
}
```

Or to size a fleet proportionally:

```ts
const agentCount = wf.budget.total !== null
  ? Math.floor(wf.budget.total / 100_000)
  : 5;
```

---

## `workflow(ref, args?)`

Runs another workflow inline, sharing the current run's concurrency cap, agent counter, budget, signal, and journal. One nesting level only — calling `workflow()` inside a child workflow throws `WorkflowError('workflow() nesting is one level only')`.

```ts
// Named workflow from the registry (pass createWorkflowRegistry to RuntimeConfig.workflows)
const subResult = await wf.workflow('analyze', { path: 'src/' });

// Inline source string
const subResult2 = await wf.workflow({
  source: `
    export const meta = { name: 'quick-check', description: 'Quick check' }
    return await agent('Quick check: ' + args)
  `,
  args: 'src/index.ts',
});
```

---

## See also

- [Workflow Runtime](/landlord/workflow) — `RuntimeConfig`, `WorkflowEvent`, quick start
- [Resume and journaling](/landlord/resume) — replaying unchanged `agent()` calls
- [Agent Types](/landlord/agent-types) — `agentType` presets and custom types
- [Isolation](/landlord/isolation) — work directory isolation backends
