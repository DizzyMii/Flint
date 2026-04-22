# decompose()

`decompose()` calls an LLM with a structured tool (`emit_plan`) to turn a free-form goal string into a `Contract[]`. Each contract represents one tenant's work.

## Signature

```ts
function decompose(
  prompt: string,
  ctx: {
    adapter: ProviderAdapter;
    model: string;
    budget?: Budget;
  }
): Promise<Result<Contract[]>>
```

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | `string` | The high-level goal to decompose |
| `ctx.adapter` | `ProviderAdapter` | Adapter for the LLM call |
| `ctx.model` | `string` | Model to use for decomposition |
| `ctx.budget` | `Budget` (optional) | Budget to consume for this call |

## Basic usage

```ts
import { decompose } from '@flint/landlord';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const result = await decompose(
  'Build a REST API with user authentication, CRUD operations, and API documentation',
  { adapter, model: 'claude-opus-4-7' }
);

if (result.ok) {
  for (const contract of result.value) {
    console.log(`${contract.role}: ${contract.objective}`);
    console.log(`  depends on: ${contract.dependsOn.join(', ') || 'nothing'}`);
  }
}
// → researcher: Research best practices for REST API auth
//     depends on: nothing
// → implementer: Implement the API with auth and CRUD
//     depends on: researcher
// → documenter: Write API documentation
//     depends on: implementer
```

## How it works

`decompose()` calls `call()` with:
1. A system prompt that instructs the model to act as the Landlord orchestrator
2. The user's goal as the user message
3. A single tool `emit_plan` that forces the model to return structured JSON

The model calls `emit_plan({ contracts: [...] })`. Each contract in the array is validated against `ContractSchema` (Zod). Malformed contracts are silently dropped. If the model doesn't call `emit_plan`, `decompose()` returns `{ ok: false }`.

## Writing effective decompose prompts

The quality of decomposition depends heavily on the prompt. Tips:

**Be specific about output format:**
```ts
await decompose(
  'Build a REST API. Each tenant should produce files in its work directory. ' +
  'The final tenant should produce an index.ts entry point.',
  { adapter, model }
);
```

**Specify the number of tenants:**
```ts
await decompose(
  'Create a 3-step pipeline: (1) research, (2) write, (3) review. No more tenants.',
  { adapter, model }
);
```

**Describe dependencies explicitly:**
```ts
await decompose(
  'Build a data pipeline where ingestion must complete before transformation, ' +
  'and transformation must complete before the report is generated.',
  { adapter, model }
);
```

## Inspecting the plan before running

Use `decompose()` directly to preview the plan without running tenants:

```ts
const plan = await decompose(myGoal, { adapter, model });
if (plan.ok) {
  console.log(JSON.stringify(plan.value, null, 2));
  // Review the contracts, then pass them to runTenant() or build orchestrate() manually
}
```

## Error cases

| Condition | Result |
|-----------|--------|
| LLM doesn't call `emit_plan` | `{ ok: false, error: Error('LLM did not call emit_plan') }` |
| All contracts are malformed | `{ ok: true, value: [] }` (empty array) |
| LLM call fails (network, budget) | `{ ok: false, error: AdapterError \| BudgetExhausted }` |

## See also

- [orchestrate()](/landlord/orchestrate) — runs decompose + execution together
- [Contracts](/landlord/contract) — Contract field reference
- [runTenant()](/landlord/tenant) — run a single contract directly
