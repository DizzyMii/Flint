# Contracts

A `Contract` is the specification given to a tenant before it starts. It defines the tenant's role, what it must produce, how to validate progress, and which other tenants it depends on.

## ContractSchema fields

```ts
type Contract = {
  tenantId: string;         // auto-generated UUID slice if omitted
  role: string;             // unique name used as dependency key
  objective: string;        // high-level goal in one sentence
  subPrompt: string;        // detailed instructions in the tenant's system prompt
  checkpoints: Checkpoint[];  // ordered milestones the tenant must hit
  outputSchema: Record<string, unknown>;  // JSON Schema for final artifact
  toolsAllowed?: string[];  // allowlist of tool names (undefined = all allowed)
  toolsDenied?: string[];   // denylist of tool names (undefined = none denied)
  dependsOn: string[];      // roles that must complete before this tenant starts
  maxRetries: number;       // max eviction+retry cycles (default: 3)
};
```

## Checkpoint fields

```ts
type Checkpoint = {
  name: string;        // identifier used as tool name suffix
  description: string; // when the tenant should call this checkpoint
  schema: Record<string, unknown>;  // JSON Schema the checkpoint data must satisfy
};
```

## Field reference

### `role`

A short, unique name for this tenant. Used as the dependency key in `dependsOn` and as the artifact key in `OrchestrateResult.artifacts`. Use kebab-case or camelCase consistently:

```ts
role: 'researcher'   // other tenants use dependsOn: ['researcher']
```

### `objective`

One sentence describing the tenant's goal. Injected into the system prompt:

```ts
objective: 'Research quantum computing and produce a structured summary with key concepts'
```

### `subPrompt`

The detailed task description the tenant receives as its user message. Be specific about expected output format:

```ts
subPrompt: `
  Research quantum computing. Cover:
  1. Core principles (superposition, entanglement, interference)
  2. Current hardware approaches (superconducting, photonic, trapped ion)
  3. Practical applications in the next 5 years

  When you have completed your research, call emit_checkpoint__research_complete
  with your findings as a JSON object.
`
```

### `checkpoints`

Ordered milestones. The tenant receives a tool named `emit_checkpoint__<name>` for each checkpoint. When called, the tool validates the input against the checkpoint's `schema`:

```ts
checkpoints: [
  {
    name: 'outline_complete',
    description: 'You have produced a structured outline with at least 3 sections',
    schema: {
      type: 'object',
      properties: {
        sections: { type: 'array', items: { type: 'string' }, minItems: 3 },
        title: { type: 'string' },
      },
      required: ['sections', 'title'],
    },
  },
  {
    name: 'draft_complete',
    description: 'You have written the full draft',
    schema: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 500 },
        wordCount: { type: 'number' },
      },
      required: ['content', 'wordCount'],
    },
  },
]
```

A tenant that finishes without calling all checkpoints is treated as failed and evicted.

### `outputSchema`

JSON Schema for the tenant's final artifact — the combined data from all passed checkpoints. Used for downstream dependency injection.

### `toolsAllowed` / `toolsDenied`

Filter which tools from `toolsFactory(workDir)` the tenant can access. `toolsAllowed` is an allowlist; `toolsDenied` is a denylist. If neither is set, all tools are available.

```ts
// Only allow file operations, no web or bash
toolsAllowed: ['file_read', 'file_write'],

// Allow everything except bash
toolsDenied: ['bash'],
```

### `dependsOn`

Roles that must complete (status: 'complete') before this tenant starts. If a dependency is escalated (all retries failed), this tenant is cancelled immediately:

```ts
dependsOn: ['researcher'],  // waits for 'researcher' to complete
```

Artifacts from completed dependencies are injected into the tenant's system prompt as context:
```
Context from dependencies:
{
  "researcher.key_concepts": [...],
  "researcher.timeline": "..."
}
```

### `maxRetries`

How many times to evict-and-retry before escalating. Default: `3`. Each retry receives the previous attempt's error as context in the system prompt.

## Manual contract construction

`decompose()` produces contracts automatically, but you can construct them manually for predictable workflows:

```ts
import { runTenant } from '@flint/landlord';
import type { Contract } from '@flint/landlord';

const researchContract: Contract = {
  tenantId: 'researcher-1',
  role: 'researcher',
  objective: 'Research a topic and produce structured findings',
  subPrompt: 'Research quantum computing. Call emit_checkpoint__findings_ready when done.',
  checkpoints: [{
    name: 'findings_ready',
    description: 'Research is complete and structured',
    schema: {
      type: 'object',
      properties: { summary: { type: 'string' }, sources: { type: 'array' } },
      required: ['summary'],
    },
  }],
  outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
  dependsOn: [],
  maxRetries: 2,
};
```

## See also

- [decompose()](/landlord/decompose) — auto-generate contracts from a prompt
- [orchestrate()](/landlord/orchestrate) — run multiple contracts
- [runTenant()](/landlord/tenant) — run a single contract
