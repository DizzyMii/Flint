# runTenant()

`runTenant()` runs a single agent loop for one tenant contract. Used directly when you have manually constructed contracts or want to run a single tenant without full orchestration.

## Signature

```ts
function runTenant(
  contract: Contract,
  tools: Tool[],
  ctx: {
    adapter: ProviderAdapter;
    model: string;
    budget?: Budget;
    workDir: string;
  },
  retryContext?: string,
  sharedArtifacts?: Record<string, unknown>
): Promise<Result<Record<string, unknown>>>
```

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `contract` | `Contract` | The tenant's specification |
| `tools` | `Tool[]` | Tools available to the tenant (filtered by `contract.toolsAllowed`/`toolsDenied`) |
| `ctx.adapter` | `ProviderAdapter` | LLM adapter |
| `ctx.model` | `string` | Model to use |
| `ctx.budget` | `Budget` | Budget (defaults to `budget({ maxSteps: 100 })` if omitted) |
| `ctx.workDir` | `string` | Filesystem sandbox directory for this tenant |
| `retryContext` | `string` (optional) | Error from previous attempt, injected into system prompt |
| `sharedArtifacts` | `Record<string, unknown>` (optional) | Artifacts from dependency tenants |

## Returns

`Result<Record<string, unknown>>` — on success, the combined checkpoint artifacts keyed by checkpoint name. On failure, the error from the final failed step.

## Basic usage

```ts
import { runTenant } from '@flint/landlord';
import { standardTools } from '@flint/landlord/tools';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import { budget } from 'flint/budget';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });
const workDir = await mkdtemp(join(tmpdir(), 'tenant-'));

const result = await runTenant(
  {
    tenantId: 'writer-1',
    role: 'writer',
    objective: 'Write a short story about a robot',
    subPrompt: 'Write a 200-word short story about a robot learning to paint. Call emit_checkpoint__story_written with the story text when done.',
    checkpoints: [{
      name: 'story_written',
      description: 'The story is complete',
      schema: {
        type: 'object',
        properties: { story: { type: 'string', minLength: 100 } },
        required: ['story'],
      },
    }],
    outputSchema: { type: 'object', properties: { story: { type: 'string' } } },
    dependsOn: [],
    maxRetries: 2,
  },
  standardTools(workDir),
  { adapter, model: 'claude-opus-4-7', workDir }
);

if (result.ok) {
  console.log(result.value.story_written); // { story: "..." }
}
```

## How the system prompt is constructed

`runTenant()` builds the tenant's system prompt from the contract:

```
You are a {role}.
Objective: {objective}

Checkpoints — call each tool when you reach the milestone:
- story_written: call `emit_checkpoint__story_written` when The story is complete

You also have filesystem and shell tools sandboxed to your working directory.
Checkpoint tools are how you declare structured results back to the orchestrator.

[Context from dependencies — if sharedArtifacts provided]
[Retry context — if retryContext provided]
```

The user message is `contract.subPrompt`.

## Checkpoint tools

For each checkpoint, `runTenant()` creates a tool named `emit_checkpoint__<name>`. When the agent calls this tool:
1. The checkpoint data is validated against the checkpoint's JSON Schema (tier-1: Ajv structural, tier-2: LLM semantic)
2. If it passes: artifacts are recorded, the tool returns success
3. If it fails: the tool returns a failure message with explanation; the agent can revise and retry

A tenant that ends without calling all checkpoint tools returns `{ ok: false }` with an error listing the missing checkpoints.

## Tool filtering

Before the tenant starts, tools are filtered by `contract.toolsAllowed` / `contract.toolsDenied`:

```ts
// Only file tools allowed
contract.toolsAllowed = ['file_read', 'file_write'];

// All tools except bash
contract.toolsDenied = ['bash'];
```

Checkpoint tools (the `emit_checkpoint__*` tools) are always included regardless of filtering.

## Retry context injection

When called with `retryContext`, the previous error is injected into the system prompt:

```
Previous attempt failed. Retry context:
Tenant finished without passing checkpoints: story_written
```

The agent uses this context to understand what went wrong and attempt a different approach.

## When to use directly vs orchestrate()

Use `runTenant()` directly when:
- You have manually constructed contracts and don't need decomposition
- You want to test a specific tenant in isolation
- You need custom retry logic or dependency management
- You're building a custom orchestrator

Use `orchestrate()` when you want the full pipeline: prompt → decompose → parallel execution → result.

## See also

- [orchestrate()](/landlord/orchestrate) — full pipeline
- [Contracts](/landlord/contract) — contract field reference
- [Standard Tools](/landlord/tools) — tools to pass to runTenant
