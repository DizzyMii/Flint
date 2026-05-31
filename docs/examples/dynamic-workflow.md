# Dynamic Workflow: Review and Verify Pipeline

This example implements a two-phase security review pipeline using the `@flint/landlord` workflow runtime. It shows the same workflow written two ways: as a string script (for model-authored workflows) and as a typed `defineWorkflow` (for production code).

## What this demonstrates

- `runWorkflowScript` — executing a model-authored JS string
- `defineWorkflow` + `runWorkflow` — the typed authoring path
- `parallel` for a barrier gather, `pipeline` for per-item multi-stage processing
- `schema` for structured output per agent
- `onEvent` progress logging
- `fileJournalStore` for crash-safe resume

## Setup

```ts
import {
  defineWorkflow,
  fileJournalStore,
  runWorkflow,
  runWorkflowScript,
} from '@flint/landlord';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import { join } from 'node:path';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });
const journal = fileJournalStore(join(process.cwd(), '.workflow-journal'));

function onEvent(e: import('@flint/landlord').WorkflowEvent) {
  switch (e.type) {
    case 'phase_started':
      console.log(`\n=== ${e.title} ===`);
      break;
    case 'agent_started':
      console.log(`  → ${e.label} [${e.agentType}] (${e.model})`);
      break;
    case 'agent_complete':
      console.log(`  ✓ ${e.label} (${e.tokens} tokens)`);
      break;
    case 'agent_error':
      console.error(`  ✗ ${e.label}: ${e.error}`);
      break;
    case 'workflow_complete':
      console.log('\n[workflow complete]');
      break;
  }
}
```

## Version 1: string script

The same logic as a model-authored JS string. This is the format the model writes when using `workflowTool`.

```ts
const source = `
export const meta = {
  name: 'security-review',
  description: 'Scan files for issues, then verify each finding independently',
  phases: [
    { title: 'Scan', detail: 'Parallel scan per file' },
    { title: 'Verify', detail: 'Independent verification per finding' }
  ]
}

const files = args

// Phase 1: scan all files in parallel (barrier — we need all findings before verifying)
phase('Scan')
const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }
  },
  required: ['file', 'issues', 'severity']
}

const rawFindings = await parallel(
  files.map(f => () => agent('Scan ' + f + ' for security vulnerabilities', {
    label: 'scan:' + f,
    agentType: 'code-reviewer',
    schema: FINDING_SCHEMA
  }))
)

const findings = rawFindings.filter(Boolean)
log('Found ' + findings.length + ' scan results')

if (findings.length === 0) {
  return { findings: [], verified: [] }
}

// Phase 2: verify each finding independently, no barrier needed between items
phase('Verify')
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    confirmed: { type: 'boolean' },
    reason: { type: 'string' },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }
  },
  required: ['confirmed', 'reason', 'severity']
}

const verified = await pipeline(
  findings,
  (finding) => agent(
    'You are an independent security reviewer. Verify this finding — is it a real vulnerability, ' +
    'or a false positive? Be skeptical. Finding: ' + JSON.stringify(finding),
    {
      label: 'verify:' + finding.file,
      agentType: 'code-reviewer',
      schema: VERIFY_SCHEMA
    }
  )
)

const confirmed = verified.filter(v => v?.confirmed)
log('Confirmed ' + confirmed.length + ' of ' + findings.length + ' findings')

return {
  findings,
  verified,
  confirmed
}
`;

const files = ['src/auth.ts', 'src/api.ts', 'src/db.ts'];

const result1 = await runWorkflowScript(source, {
  adapter,
  models: { default: 'claude-opus-4-7' },
  args: files,
  journal,
  runId: 'review-001',
  onEvent,
});

if (result1.ok) {
  const { findings, confirmed } = result1.value.result as {
    findings: unknown[];
    confirmed: unknown[];
  };
  console.log(`\nTotal findings: ${findings.length}`);
  console.log(`Confirmed vulnerabilities: ${confirmed.length}`);
  console.log('runId:', result1.value.runId);
}
```

## Version 2: typed workflow

The identical logic using `defineWorkflow` — fully type-checked, no eval.

```ts
type Finding = {
  file: string;
  issues: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
};

type Verification = {
  confirmed: boolean;
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
};

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
  },
  required: ['file', 'issues', 'severity'],
} as const;

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    confirmed: { type: 'boolean' },
    reason: { type: 'string' },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
  },
  required: ['confirmed', 'reason', 'severity'],
} as const;

const reviewWorkflow = defineWorkflow({
  meta: {
    name: 'security-review',
    description: 'Scan files for issues, then verify each finding independently',
    phases: [
      { title: 'Scan', detail: 'Parallel scan per file' },
      { title: 'Verify', detail: 'Independent verification per finding' },
    ],
  },

  run: async (wf) => {
    const files = wf.args as string[];

    // Phase 1: scan all files in parallel — barrier because we want all findings before verifying
    wf.phase('Scan');
    const rawFindings = await wf.parallel(
      files.map((f) => () =>
        wf.agent(`Scan ${f} for security vulnerabilities`, {
          label: `scan:${f}`,
          agentType: 'code-reviewer',
          schema: FINDING_SCHEMA,
        }),
      ),
    );

    const findings = rawFindings.filter((f): f is Finding => f !== null);
    wf.log(`Found ${findings.length} scan results`);

    if (findings.length === 0) {
      return { findings: [], verified: [], confirmed: [] };
    }

    // Phase 2: verify each finding — pipeline because each item is independent
    wf.phase('Verify');
    const verified = await wf.pipeline(
      findings,
      (finding) =>
        wf.agent(
          `You are an independent security reviewer. Verify this finding — is it a real ` +
            `vulnerability, or a false positive? Be skeptical. Finding: ${JSON.stringify(finding)}`,
          {
            label: `verify:${(finding as Finding).file}`,
            agentType: 'code-reviewer',
            schema: VERIFY_SCHEMA,
          },
        ),
    );

    const confirmed = (verified as Array<Verification | null>).filter(
      (v): v is Verification => v?.confirmed === true,
    );
    wf.log(`Confirmed ${confirmed.length} of ${findings.length} findings`);

    return { findings, verified, confirmed };
  },
});

const result2 = await runWorkflow(reviewWorkflow, {
  adapter,
  models: { default: 'claude-opus-4-7' },
  args: ['src/auth.ts', 'src/api.ts', 'src/db.ts'],
  journal,
  runId: 'review-002',
  onEvent,
});

if (result2.ok) {
  const output = result2.value.result as {
    findings: Finding[];
    confirmed: Verification[];
  };
  console.log(`\nTotal findings: ${output.findings.length}`);
  console.log(`Confirmed vulnerabilities: ${output.confirmed.length}`);

  for (const v of output.confirmed) {
    console.log(`  [${v.severity}] ${v.reason}`);
  }
}
```

## Resume after a crash

If the run crashes halfway (e.g. network error during the Verify phase), you can resume without re-running the Scan phase:

```ts
const resumed = await runWorkflow(reviewWorkflow, {
  adapter,
  models: { default: 'claude-opus-4-7' },
  args: ['src/auth.ts', 'src/api.ts', 'src/db.ts'],
  journal,
  runId: 'review-003',
  resumeFromRunId: 'review-002', // replay unchanged prefix from this run
  onEvent,
});
```

The Scan agents whose calls are journaled will be replayed instantly. The first Verify agent that didn't complete will re-run live, and all subsequent agents will run live too.

## Expected output

```
=== Scan ===
  → scan:src/auth.ts [code-reviewer] (claude-opus-4-7)
  → scan:src/api.ts [code-reviewer] (claude-opus-4-7)
  → scan:src/db.ts [code-reviewer] (claude-opus-4-7)
  ✓ scan:src/auth.ts (1240 tokens)
  ✓ scan:src/api.ts (980 tokens)
  ✓ scan:src/db.ts (1105 tokens)

=== Verify ===
  → verify:src/auth.ts [code-reviewer] (claude-opus-4-7)
  ✓ verify:src/auth.ts (850 tokens)
  → verify:src/api.ts [code-reviewer] (claude-opus-4-7)
  ✓ verify:src/api.ts (720 tokens)
  → verify:src/db.ts [code-reviewer] (claude-opus-4-7)
  ✓ verify:src/db.ts (910 tokens)

[workflow complete]

Total findings: 3
Confirmed vulnerabilities: 2
  [high] SQL query in db.ts line 42 uses string concatenation — SQL injection risk
  [medium] auth.ts token expiry not validated on refresh path
```

## See also

- [Workflow Runtime](/landlord/workflow) — `RuntimeConfig`, `WorkflowEvent`
- [Hooks reference](/landlord/hooks) — `parallel` vs `pipeline`, `schema` for structured output
- [Resume and journaling](/landlord/resume) — how the journal replay works
- [Agent Types](/landlord/agent-types) — `code-reviewer` and other built-in presets
- [Multi-Agent with Landlord](/examples/multi-agent) — the `orchestrate()` equivalent
