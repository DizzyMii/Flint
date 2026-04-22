# orchestrate()

`orchestrate()` runs the complete landlord pipeline: decompose a goal into contracts, sort by dependency, run all tenants in parallel (where dependencies allow), collect artifacts, and return the result.

## Signature

```ts
function orchestrate(
  prompt: string,
  toolsFactory: (workDir: string) => Tool[],
  config: OrchestratorConfig
): Promise<Result<OrchestrateResult>>
```

## OrchestratorConfig

```ts
type OrchestratorConfig = {
  adapter: ProviderAdapter;
  landlordModel: string;
  tenantModel: string;
  budget?: Budget;
  outputDir?: string;
  onEvent?: (event: LandlordEvent) => void;
};
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adapter` | `ProviderAdapter` | ✓ | Adapter for all LLM calls (decompose + tenants) |
| `landlordModel` | `string` | ✓ | Model used for `decompose()` |
| `tenantModel` | `string` | ✓ | Model used for each `runTenant()` |
| `budget` | `Budget` | — | Shared budget across the entire job. All calls consume from this pool. |
| `outputDir` | `string` | — | Base directory for tenant work dirs. Default: OS tmpdir + timestamp. |
| `onEvent` | `(e: LandlordEvent) => void` | — | Progress callback. Called synchronously from within the orchestrator. |

## OrchestrateResult

```ts
type OrchestrateResult = {
  status: 'complete' | 'partial';
  tenants: Record<string, TenantOutcome>;
  artifacts: Record<string, Record<string, unknown>>;
};

type TenantOutcome =
  | { status: 'complete'; artifacts: Record<string, unknown> }
  | { status: 'escalated'; lastError: string; retriesExhausted: number };
```

- `status: 'complete'` — all tenants finished successfully
- `status: 'partial'` — at least one tenant was escalated; others may have completed
- `artifacts` — keyed by role, contains the combined checkpoint outputs for each completed tenant

## LandlordEvent

```ts
type LandlordEvent =
  | { type: 'tenant_started'; role: string }
  | { type: 'checkpoint_passed'; role: string; checkpoint: string }
  | { type: 'checkpoint_failed'; role: string; checkpoint: string; reason: string }
  | { type: 'tenant_complete'; role: string }
  | { type: 'tenant_evicted'; role: string; reason: string; retry: number }
  | { type: 'tenant_escalated'; role: string }
  | { type: 'job_complete'; artifacts: Record<string, Record<string, unknown>> };
```

## Full example with progress logging

```ts
import { orchestrate } from '@flint/landlord';
import { standardTools } from '@flint/landlord/tools';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import { budget } from 'flint/budget';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });
const b = budget({ maxDollars: 3.00, maxSteps: 300 });

const result = await orchestrate(
  'Write a technical blog post about WebAssembly with code examples',
  (workDir) => standardTools(workDir),
  {
    adapter,
    landlordModel: 'claude-opus-4-7',
    tenantModel: 'claude-opus-4-7',
    budget: b,
    outputDir: './output/wasm-post',
    onEvent: (event) => {
      switch (event.type) {
        case 'tenant_started':
          console.log(`▶ [${event.role}] started`);
          break;
        case 'checkpoint_passed':
          console.log(`  ✓ [${event.role}] checkpoint: ${event.checkpoint}`);
          break;
        case 'checkpoint_failed':
          console.log(`  ✗ [${event.role}] checkpoint failed: ${event.reason}`);
          break;
        case 'tenant_evicted':
          console.log(`  ↩ [${event.role}] evicted (retry ${event.retry}): ${event.reason}`);
          break;
        case 'tenant_escalated':
          console.log(`  ✗ [${event.role}] escalated — all retries exhausted`);
          break;
        case 'tenant_complete':
          console.log(`✓ [${event.role}] complete`);
          break;
        case 'job_complete':
          console.log('Job complete. Artifacts:', Object.keys(event.artifacts));
          break;
      }
    },
  }
);

console.log(`Budget used: $${(3.00 - (b.remaining().dollars ?? 0)).toFixed(4)}`);

if (!result.ok) {
  console.error('Orchestration failed:', result.error.message);
} else if (result.value.status === 'partial') {
  const escalated = Object.entries(result.value.tenants)
    .filter(([, o]) => o.status === 'escalated')
    .map(([role]) => role);
  console.warn('Partial result — escalated tenants:', escalated);
} else {
  console.log('All tenants complete');
  for (const [role, artifacts] of Object.entries(result.value.artifacts)) {
    console.log(`${role}:`, Object.keys(artifacts));
  }
}
```

## Dependency resolution

`orchestrate()` calls `resolveOrder()` (DFS topological sort) on the contracts before dispatching. If the contracts have a circular dependency, `orchestrate()` returns `{ ok: false, error: DependencyCycleError }` before any tenants start.

Independent tenants run via `Promise.all` — no artificial sequencing. Dependent tenants await a gate that resolves when their dependency completes.

## Artifact flow between tenants

When a tenant completes, its artifacts are stored. Dependent tenants that start later receive those artifacts injected into their system prompt:

```
Context from dependencies:
{
  "researcher.findings": "WebAssembly (Wasm) is a binary instruction format...",
  "researcher.sources": ["https://webassembly.org", "..."]
}
```

The injection key format is `<role>.<checkpointName>`.

## Failure and retry

When a tenant fails (checkpoint failed or agent error), it's **evicted**: the tenant restarts with:
- The previous error message injected as "Previous attempt failed. Retry context: ..."
- A fresh `agent()` loop (no accumulated message history from the failed attempt)

After `maxRetries` evictions, the tenant is **escalated**: its gate resolves with empty artifacts. Any tenant that `dependsOn` an escalated tenant is immediately cancelled (also escalated) without starting.

## See also

- [decompose()](/landlord/decompose) — how the prompt becomes contracts
- [runTenant()](/landlord/tenant) — run one contract directly
- [Contracts](/landlord/contract) — contract field reference
- [Standard Tools](/landlord/tools) — tools to pass via toolsFactory
