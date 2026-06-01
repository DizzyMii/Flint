# Workflow Runtime

The workflow runtime is the core of `@flint/landlord`. It lets you drive multiple subagents with plain TypeScript — writing real control flow (loops, conditionals, fan-out) rather than declaring a static DAG.

## Mental model

A workflow is a function (or a JS string) that receives a set of hooks and calls them to orchestrate work:

```
runWorkflowScript(source, config)
  └── compileScript(source)          ← parse meta, strip exports, wrap in AsyncFunction
        └── executeModule(module, deps)
              └── buildContext(deps)  ← inject agent/parallel/pipeline/phase/log/args/budget/workflow
                    └── module.run(wf)
                          ├── wf.phase('Find')
                          ├── wf.parallel([...])     ← concurrent with barrier
                          ├── wf.pipeline(items, ...) ← no barrier between stages
                          └── wf.agent(prompt, opts)  ← spawns one subagent
```

Every `agent()` call runs a full Flint `agent()` loop in an isolated work directory. Concurrency is capped automatically; a per-run agent counter prevents runaway workflows.

## Two authoring paths

### String script (`runWorkflowScript`)

The model writes a workflow as a plain JS string. The runtime parses a `meta` block, sandboxes nondeterminism, and injects hooks as globals:

```ts
import { runWorkflowScript } from '@flint/landlord';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const source = `
export const meta = { name: 'review', description: 'Review and verify findings' }

const files = args
phase('Find')
const findings = await parallel(files.map(f => () => agent(
  'Review ' + f + ' for security issues',
  { schema: { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } } }, required: ['issues'] } }
)))

phase('Verify')
const verified = await pipeline(
  findings.filter(Boolean),
  (f) => agent('Verify this finding — is it a real vulnerability? ' + JSON.stringify(f),
    { schema: { type: 'object', properties: { confirmed: { type: 'boolean' }, reason: { type: 'string' } }, required: ['confirmed', 'reason'] } })
)

return verified.filter(v => v?.confirmed)
`;

const files = ['src/auth.ts', 'src/api.ts'];
const result = await runWorkflowScript(source, {
  adapter,
  models: { default: 'claude-opus-4-7' },
  args: files,
  onEvent: (e) => {
    if (e.type === 'phase_started') console.log(`\n=== ${e.title} ===`);
    if (e.type === 'agent_complete') console.log(`  done: ${e.label} (${e.tokens} tokens)`);
  },
});

if (result.ok) {
  console.log('Confirmed vulnerabilities:', result.value.result);
}
```

The value passed as `args` is exposed to the script as the global `args`. Here the host passes the file list via `args: files`, and the script binds it locally with `const files = args` before using it.

### Typed workflow (`defineWorkflow`)

For production code where you want type checking:

```ts
import { defineWorkflow, runWorkflow } from '@flint/landlord';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const reviewWorkflow = defineWorkflow({
  meta: {
    name: 'review',
    description: 'Review and verify findings',
    phases: [
      { title: 'Find', detail: 'Scan files for issues' },
      { title: 'Verify', detail: 'Confirm each finding is real' },
    ],
  },
  run: async (wf) => {
    const files = wf.args as string[];

    wf.phase('Find');
    const findings = await wf.parallel(
      files.map((f) => () =>
        wf.agent(`Review ${f} for security issues`, {
          schema: {
            type: 'object',
            properties: { issues: { type: 'array', items: { type: 'string' } } },
            required: ['issues'],
          },
        }),
      ),
    );

    wf.phase('Verify');
    const verified = await wf.pipeline(
      findings.filter(Boolean),
      (finding) =>
        wf.agent(`Verify this finding — is it a real vulnerability? ${JSON.stringify(finding)}`, {
          schema: {
            type: 'object',
            properties: {
              confirmed: { type: 'boolean' },
              reason: { type: 'string' },
            },
            required: ['confirmed', 'reason'],
          },
        }),
    );

    return (verified as Array<{ confirmed: boolean } | null>).filter((v) => v?.confirmed);
  },
});

const result = await runWorkflow(reviewWorkflow, {
  adapter,
  models: { default: 'claude-opus-4-7' },
  args: ['src/auth.ts', 'src/api.ts'],
});

if (result.ok) {
  console.log('runId:', result.value.runId);
  console.log('Result:', result.value.result);
}
```

## RuntimeConfig

Both `runWorkflowScript` and `runWorkflow` accept the same `RuntimeConfig`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `adapter` | `ProviderAdapter` | required | Flint provider adapter for all model calls |
| `models` | `{ default: string; [tier: string]: string }` | required | Model tier map. `models.default` is used unless overridden per agent |
| `args` | `unknown` | `undefined` | Value passed into the workflow as `wf.args` / the `args` global |
| `budget` | `Budget` | unlimited steps | Shared Flint `Budget` across all agent calls |
| `tokenTarget` | `number \| null` | `null` | Optional output-token ceiling. Agents fail with `WorkflowError` after this many output tokens |
| `registry` | `AgentTypeRegistry` | built-ins | Custom agent-type registry (merged over built-ins if using `createAgentRegistry`) |
| `workflows` | `WorkflowRegistry` | none | Named workflow registry for `workflow(name)` calls |
| `journal` | `JournalStore` | `memoryJournalStore()` | Journal backend for resume. Use `fileJournalStore(dir)` for persistence across processes |
| `isolation` | `IsolationBackend` | `workdirIsolation(baseDir)` | Default isolation backend for all agents |
| `worktreeRepoDir` | `string` | none | Enables `gitWorktreeIsolation` for agents that pass `isolation: 'worktree'` |
| `baseDir` | `string` | `os.tmpdir()/flint-workflow-<runId>` | Base directory for isolated work dirs |
| `concurrency` | `number` | `max(1, min(16, cpus-2))` | Semaphore limit — max agents running simultaneously |
| `agentCap` | `number` | `1000` | Lifetime agent counter ceiling per run |
| `onEvent` | `(e: WorkflowEvent) => void` | none | Progress callback for all workflow events |
| `signal` | `AbortSignal` | none | Cancels in-flight agents and skips queued ones |
| `runId` | `string` | random UUID slice | ID for the current run (used as journal key) |
| `resumeFromRunId` | `string` | none | Load the journal for this prior `runId` and replay the unchanged prefix |

## WorkflowEvent catalog

```ts
type WorkflowEvent =
  | { type: 'phase_started'; title: string }
  | { type: 'log'; message: string }
  | { type: 'agent_started'; label: string; phase?: string; agentType: string; model: string }
  | { type: 'agent_complete'; label: string; phase?: string; tokens: number }
  | { type: 'agent_error'; label: string; phase?: string; error: string }
  | { type: 'workflow_complete'; result: unknown };
```

- `phase_started` — fired when `wf.phase(title)` is called
- `log` — fired when `wf.log(message)` is called
- `agent_started` — fired before each agent loop starts (includes model and agentType)
- `agent_complete` — fired when an agent loop finishes successfully (includes total tokens used)
- `agent_error` — fired when an agent loop throws; the error propagates unless wrapped in `parallel`/`pipeline`
- `workflow_complete` — fired after `run()` returns, carries the return value

## Comparison: which orchestration primitive?

| | `runWorkflow` / `runWorkflowScript` | `orchestrate()` | `@flint/graph` | `agent()` |
|-|-------------------------------------|-----------------|----------------|-----------|
| **Authoring** | Code (imperative loops, fan-out) | Prompt (LLM decomposes) | State-machine nodes | Single loop |
| **Control flow** | You write it | Auto-generated DAG | Explicit transitions | Tool calls |
| **Structured output** | `schema` per agent | Checkpoints per tenant | Node output types | Tools |
| **Resume** | Yes — journaling | No | Yes — checkpoints | No |
| **Best for** | Scripted multi-phase pipelines | Open-ended goals | Stateful multi-turn | Single-agent tasks |

`orchestrate()` itself is now a built-in workflow on this runtime. The APIs are independent; pick the one that matches how much control you want.

## See also

- [Hooks reference](/landlord/hooks) — full `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow` API
- [Resume and journaling](/landlord/resume) — how to resume a crashed run
- [Agent Types](/landlord/agent-types) — built-in presets and custom agent types
- [Isolation](/landlord/isolation) — per-agent work directories and git-worktree backends
- [Workflow Tool](/landlord/workflow-tool) — give a model the ability to write and run workflows
- [Dynamic Workflow Example](/examples/dynamic-workflow) — a complete review pipeline, both string and typed
