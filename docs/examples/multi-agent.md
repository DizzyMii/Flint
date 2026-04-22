# Multi-Agent with Landlord

This example uses `@flint/landlord` to run a 3-tenant pipeline: a researcher, a writer, and a reviewer working sequentially with artifact handoff between stages.

## What this demonstrates

- `orchestrate()` — full landlord pipeline
- `Contract` construction with dependencies
- `LandlordEvent` progress callbacks
- Artifact flow between dependent tenants

## The pipeline

```
researcher ──→ writer ──→ reviewer
(independent)  (depends on researcher)  (depends on writer)
```

## Setup

```ts
import { orchestrate } from '@flint/landlord';
import { standardTools } from '@flint/landlord/tools';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import { budget } from 'flint/budget';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });
```

## Run the pipeline

```ts
const result = await orchestrate(
  // The goal — decompose() turns this into contracts automatically
  'Write a technical article about WebAssembly for a developer audience. ' +
  'Include: core concepts, use cases, and a Rust code example. ' +
  'The pipeline should have a researcher, writer, and reviewer.',
  (workDir) => standardTools(workDir),
  {
    adapter,
    landlordModel: 'claude-opus-4-7',
    tenantModel: 'claude-opus-4-7',
    budget: budget({ maxDollars: 2.00, maxSteps: 200 }),
    outputDir: './output/wasm-article',
    onEvent: (event) => {
      switch (event.type) {
        case 'tenant_started':
          console.log(`\n▶ ${event.role}`);
          break;
        case 'checkpoint_passed':
          console.log(`  ✓ ${event.checkpoint}`);
          break;
        case 'tenant_evicted':
          console.log(`  ↩ retry ${event.retry}: ${event.reason.slice(0, 80)}`);
          break;
        case 'tenant_escalated':
          console.error(`  ✗ ${event.role} failed`);
          break;
      }
    },
  }
);
```

## Read the results

```ts
if (!result.ok) {
  console.error('Failed:', result.error.message);
  process.exit(1);
}

const { status, tenants, artifacts } = result.value;
console.log('\nStatus:', status);

for (const [role, outcome] of Object.entries(tenants)) {
  if (outcome.status === 'complete') {
    console.log(`${role}: complete`);
    console.log('  artifacts:', Object.keys(outcome.artifacts));
  } else {
    console.log(`${role}: escalated — ${outcome.lastError}`);
  }
}

// Access specific artifacts
if (artifacts.writer) {
  console.log('\nFinal article:');
  console.log(artifacts.writer.draft_complete?.content ?? 'No content');
}
```

## Expected output

```
▶ researcher
  ✓ research_complete

▶ writer
  ✓ outline_complete
  ✓ draft_complete

▶ reviewer
  ✓ review_complete

Status: complete
researcher: complete
  artifacts: [ 'research_complete' ]
writer: complete
  artifacts: [ 'outline_complete', 'draft_complete' ]
reviewer: complete
  artifacts: [ 'review_complete' ]
```

## Manual contract construction

If you want full control over the contracts instead of using `decompose()`, use `runTenant()` directly:

```ts
import { runTenant } from '@flint/landlord';
import { standardTools } from '@flint/landlord/tools';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = await mkdtemp(join(tmpdir(), 'researcher-'));

const researchResult = await runTenant(
  {
    tenantId: 'researcher-1',
    role: 'researcher',
    objective: 'Research WebAssembly thoroughly',
    subPrompt: 'Research WebAssembly: core concepts, use cases, language support. Call emit_checkpoint__research_complete with structured findings.',
    checkpoints: [{
      name: 'research_complete',
      description: 'Research is complete',
      schema: {
        type: 'object',
        properties: {
          concepts: { type: 'array', items: { type: 'string' } },
          useCases: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
        required: ['concepts', 'summary'],
      },
    }],
    outputSchema: { type: 'object' },
    dependsOn: [],
    maxRetries: 2,
  },
  standardTools(workDir),
  { adapter, model: 'claude-opus-4-7', workDir }
);
```

## See also

- [What is Landlord?](/landlord/) — concepts and mental model
- [orchestrate()](/landlord/orchestrate) — full API reference
- [Contracts](/landlord/contract) — contract field reference
- [Standard Tools](/landlord/tools) — bash, file, and web tools
