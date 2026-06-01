# What is Landlord?

`@flint/landlord` is an orchestration layer that decomposes a high-level goal into a set of isolated AI agent workers — called **tenants** — each with a defined role, objective, and output schema. Tenants run in parallel where their dependencies allow. The orchestrator (the "landlord") manages scheduling, validates progress at checkpoints, retries failed tenants, and collects artifacts.

## Mental model

```
prompt
  └── decompose()         ← LLM breaks goal into Contract[]
        └── resolveOrder()  ← topological sort by dependsOn
              └── Promise.all(runTenant per contract)
                    ├── tenant "researcher"   (independent)
                    ├── tenant "writer"       (depends on researcher)
                    └── tenant "reviewer"     (depends on writer)
                          └── OrchestrateResult { artifacts }
```

Each tenant is an isolated `agent()` loop with:
- Its own working directory (filesystem sandbox)
- Checkpoint tools it must call to prove progress
- A tool allowlist/denylist from the contract
- Retry-on-failure up to `maxRetries` times

## Install

```sh
npm install @flint/landlord
```

Requires `flint` as a peer dependency.

## Quick start

```ts
import { orchestrate } from '@flint/landlord';
import { standardTools } from '@flint/landlord/tools';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import { budget } from 'flint/budget';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const result = await orchestrate(
  'Build a REST API for a todo app with CRUD endpoints and SQLite storage',
  (workDir) => standardTools(workDir), // each tenant gets sandboxed tools
  {
    adapter,
    landlordModel: 'claude-opus-4-7',   // model used to decompose the goal
    tenantModel: 'claude-opus-4-7',      // model used for each tenant
    budget: budget({ maxDollars: 2.00, maxSteps: 200 }),
    onEvent: (event) => {
      if (event.type === 'tenant_started') console.log(`▶ ${event.role} started`);
      if (event.type === 'checkpoint_passed') console.log(`✓ ${event.role}: ${event.checkpoint}`);
      if (event.type === 'tenant_complete') console.log(`✓ ${event.role} complete`);
      if (event.type === 'tenant_escalated') console.log(`✗ ${event.role} escalated: ${event}`);
    },
  }
);

if (result.ok) {
  console.log('Status:', result.value.status); // 'complete' or 'partial'
  console.log('Artifacts:', result.value.artifacts);
}
```

## Key concepts

| Term | Description |
|------|-------------|
| **Contract** | The specification for one tenant: role, objective, checkpoints, output schema, dependencies |
| **Checkpoint** | A milestone the tenant must reach, validated against a JSON Schema |
| **Tenant** | An `agent()` loop running a single contract in an isolated work directory |
| **Artifact** | The structured output a tenant produces by passing all its checkpoints |
| **Eviction** | When a tenant fails a checkpoint or runs out of budget — triggers retry |
| **Escalation** | When a tenant exhausts all retries — its dependents are cancelled |

## Two ways to orchestrate

### Script-driven workflow runtime (new)

Write TypeScript that drives subagents directly using hooks (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`). You control the control flow — loops, conditionals, fan-out are all plain code.

```ts
import { defineWorkflow, runWorkflow } from '@flint/landlord';

const workflow = defineWorkflow({
  meta: { name: 'review', description: 'Review and verify findings' },
  run: async (wf) => {
    wf.phase('Scan');
    const findings = await wf.parallel(
      (wf.args as string[]).map((f) => () =>
        wf.agent(`Scan ${f} for issues`, { agentType: 'code-reviewer', schema: FINDINGS_SCHEMA }),
      ),
    );
    return findings.filter(Boolean);
  },
});

const result = await runWorkflow(workflow, { adapter, models: { default: 'claude-opus-4-7' } });
```

The model can also write the workflow as a string script via `runWorkflowScript` or the `workflowTool`. See [Workflow Runtime](/landlord/workflow) for the full API.

### Auto-decompose (`orchestrate()`)

Describe the goal in a prompt; the orchestrator asks an LLM to decompose it into a `Contract[]` (a DAG of worker specs) and then runs all tenants in parallel where dependencies allow. Useful when the decomposition strategy itself should be model-driven.

```ts
import { orchestrate } from '@flint/landlord';

const result = await orchestrate(
  'Build a REST API for a todo app with CRUD endpoints and SQLite storage',
  (workDir) => standardTools(workDir),
  { adapter, landlordModel: 'claude-opus-4-7', tenantModel: 'claude-opus-4-7' }
);
```

`orchestrate()` is now built on the workflow runtime internally — it shares the same concurrency cap, journaling, and event system. Its public API and behavior are unchanged.

## When to use landlord vs agent()

Use `agent()` when a single model can accomplish the goal in one continuous loop. Use landlord when:

- The work can be meaningfully parallelised across independent roles
- You need structured, validated output at each stage (not just a final message)
- You want automatic retry-on-failure with error context passed to retries
- The task is large enough that a single context window is a bottleneck

## See also

- [Workflow Runtime](/landlord/workflow) — script-driven multi-agent orchestration
- [Hooks reference](/landlord/hooks) — `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`
- [Contracts](/landlord/contract) — Contract and Checkpoint schemas
- [decompose()](/landlord/decompose) — how goals become contract lists
- [orchestrate()](/landlord/orchestrate) — full orchestration API
- [runTenant()](/landlord/tenant) — run a single tenant directly
- [Standard Tools](/landlord/tools) — bash, file, and web tools
