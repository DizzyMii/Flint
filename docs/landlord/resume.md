# Resume and Journaling

The workflow runtime journals every `agent()` call. If a run crashes or times out, you can restart it with `resumeFromRunId` and it will replay the unchanged prefix from the journal — skipping all the model calls that already succeeded.

## How journaling works

Every `agent()` call:

1. Computes an index (monotonically incremented per run) and a hash of `{ prompt, opts }`.
2. Checks the loaded resume entries for an entry with the same `index` and `hash`.
3. If found — returns the cached result immediately (no model call, no slot acquired).
4. If not found — runs live, then appends `{ index, hash, result }` to the journal.

The first divergence (different prompt/opts or new index) runs live. Everything after it runs live too. Same script + same args guarantees a 100% cache hit on resume.

## JournalStore interface

```ts
interface JournalStore {
  append(runId: string, entry: JournalEntry): Promise<void>;
  load(runId: string): Promise<JournalEntry[]>;
}

type JournalEntry = {
  index: number;   // monotonic call counter
  hash: string;    // FNV-1a of stableStringify({ prompt, opts })
  result: unknown; // the captured return value
};
```

## `memoryJournalStore()`

The default. Stores entries in memory — not persistent across process restarts. Useful for testing and short-lived runs.

```ts
import { memoryJournalStore, runWorkflowScript } from '@flint/landlord';

const journal = memoryJournalStore();
const source = `
export const meta = { name: 'review', description: 'Review files' }
const result = await agent('Review src/auth.ts for issues')
return result
`;

const r1 = await runWorkflowScript(source, {
  adapter,
  models: { default: 'claude-opus-4-7' },
  journal,
  runId: 'run-001',
});
// r1.ok === true, r1.value.result === 'some review text'

// Simulate a resume in the same process (e.g. after a downstream failure):
const r2 = await runWorkflowScript(source, {
  adapter: throwingAdapter, // never called — replay hits cache
  models: { default: 'claude-opus-4-7' },
  journal,
  runId: 'run-002',
  resumeFromRunId: 'run-001',
});
// r2.ok === true, r2.value.result === 'some review text' (replayed)
```

## `fileJournalStore(dir)`

Persists entries as JSONL files on disk — survives process restarts. Each run gets its own file: `journal-<runId>.jsonl`.

```ts
import { fileJournalStore, runWorkflowScript } from '@flint/landlord';
import { join } from 'node:path';

const journal = fileJournalStore(join(process.cwd(), '.workflow-journal'));

// First run: calls the model and writes to disk
const r1 = await runWorkflowScript(source, {
  adapter,
  models: { default: 'claude-opus-4-7' },
  journal,
  runId: 'run-001',
});

// Later (even in a fresh process): resume from disk
const r2 = await runWorkflowScript(source, {
  adapter,
  models: { default: 'claude-opus-4-7' },
  journal,
  runId: 'run-002',
  resumeFromRunId: 'run-001',
});
```

## Full resume example

A realistic pattern: run once, crash halfway, resume without repeating the expensive calls.

```ts
import {
  defineWorkflow,
  fileJournalStore,
  runWorkflow,
} from '@flint/landlord';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import { join } from 'node:path';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });
const journal = fileJournalStore(join(process.cwd(), '.workflow-journal'));

const auditWorkflow = defineWorkflow({
  meta: { name: 'audit', description: 'Audit a codebase' },
  run: async (wf) => {
    wf.phase('Scan');
    const scan = await wf.agent('Scan the codebase for TODOs and FIXMEs');

    wf.phase('Analyze');
    // If this agent fails and the run crashes, the 'Scan' agent above is journaled
    const analysis = await wf.agent('Analyze these items and prioritize: ' + String(scan));

    wf.phase('Report');
    const report = await wf.agent('Write a summary report of: ' + String(analysis));

    return { scan, analysis, report };
  },
});

async function runWithResume(runId: string, resumeFromRunId?: string) {
  return runWorkflow(auditWorkflow, {
    adapter,
    models: { default: 'claude-opus-4-7' },
    journal,
    runId,
    resumeFromRunId,
  });
}

// First attempt
const r1 = await runWithResume('audit-2026-05-31-a');
if (!r1.ok) {
  console.error('Run failed:', r1.error.message);
  // Resume from the partial run — 'Scan' will be replayed, 'Analyze' re-runs
  const r2 = await runWithResume('audit-2026-05-31-b', 'audit-2026-05-31-a');
  if (r2.ok) console.log('Resumed result:', r2.value.result);
}
```

## Determinism requirement

Resume works by replaying a hash match: `hash(prompt, opts)` at the same call index. This requires the workflow to produce the same call sequence on restart.

**String scripts:** The sandbox blocks `Date.now()`, `new Date()`, and `Math.random()` (they throw). This enforces determinism automatically. Pass timestamps or seeds via `args`.

**Typed workflows:** The sandbox cannot intercept lexical globals. You are responsible for avoiding nondeterminism in the `run` function:

- Do not call `Date.now()` or `Math.random()` inside `run()`.
- Do not vary calls based on external state that could change between runs.
- Pass any variable inputs through `wf.args`.

If the call sequence diverges from the journal, the divergence point and all subsequent calls run live — the partial cache is still useful; you just lose hits after the divergence.

## See also

- [Workflow Runtime](/landlord/workflow) — `RuntimeConfig` fields `runId`, `resumeFromRunId`, `journal`
- [Hooks reference](/landlord/hooks) — `agent()` call semantics
- [Dynamic Workflow Example](/examples/dynamic-workflow) — end-to-end example with journaling
