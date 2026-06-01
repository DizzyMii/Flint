# Workflow Tool

`workflowTool` wraps the workflow runtime as a Flint `Tool`. Drop it into any `agent()` call and that agent can author workflow scripts and run them — giving the model the same orchestration capabilities described in the rest of this section.

## `workflowTool(config)`

```ts
import { workflowTool } from '@flint/landlord';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const wfTool = workflowTool({
  adapter,
  models: { default: 'claude-opus-4-7' },
});
```

### WorkflowToolConfig

```ts
type WorkflowToolConfig = {
  adapter: ProviderAdapter;
  models: Models;
  registry?: AgentTypeRegistry;   // custom agent types
  workflows?: WorkflowRegistry;   // named registered workflows
  journal?: JournalStore;         // journal backend (default: memoryJournalStore)
  isolation?: IsolationBackend;   // isolation backend (default: workdirIsolation)
  onEvent?: EventSink;            // progress callback
};
```

The tool is named `workflow` and accepts:

| Input field | Type | Description |
|-------------|------|-------------|
| `script` | `string` | A workflow JS script starting with `export const meta = { ... }` |
| `args` | `unknown` | Value exposed to the script as `args` |
| `name` | `string` | Name of a registered workflow to run instead of `script` |
| `resumeFromRunId` | `string` | Resume a prior run, replaying unchanged agents |

The handler returns a JSON string `{ runId: string, result: unknown }`. On error it returns a string starting with `Error:` so the calling agent can see the message and retry or escalate.

## Using the tool in an agent

```ts
import { agent } from 'flint';
import { budget } from 'flint/budget';
import { workflowTool, WORKFLOW_TOOL_GUIDE } from '@flint/landlord';

const wfTool = workflowTool({ adapter, models: { default: 'claude-opus-4-7' } });

const result = await agent({
  adapter,
  model: 'claude-opus-4-7',
  messages: [
    { role: 'system', content: WORKFLOW_TOOL_GUIDE },
    { role: 'user', content: 'Audit the src/ directory for security vulnerabilities. ' +
      'Use a multi-agent pipeline: first scan all files, then verify each finding independently.' },
  ],
  tools: [wfTool],
  budget: budget({ maxSteps: 20, maxDollars: 5.00 }),
});

if (result.ok) {
  console.log('Agent response:', result.value.message.content);
}
```

## `WORKFLOW_TOOL_GUIDE`

A system-prompt string that teaches the model how to author effective workflows. It covers:

- The meta block syntax and all available hooks
- The barrier-vs-no-barrier distinction (`parallel` vs `pipeline`)
- When to use `schema` for structured output
- The concurrency and agent cap
- Quality patterns: adversarial verify, judge panel, loop-until-dry, multi-modal sweep, completeness critic

Paste it into any system prompt where you want the model to reason about multi-agent orchestration. The `orchestratorAgent` helper does this automatically.

## `orchestratorAgent(config)`

A convenience wrapper that pre-wires `workflowTool` and `WORKFLOW_TOOL_GUIDE` into a callable agent function:

```ts
import { orchestratorAgent } from '@flint/landlord';
import { budget } from 'flint/budget';

const orchestrate = orchestratorAgent({
  adapter,
  models: { default: 'claude-opus-4-7' },
});

// Call it like a regular agent
const result = await orchestrate(
  'Build a comprehensive review of the authentication system. ' +
  'Cover: implementation quality, security posture, and test coverage.',
  { budget: budget({ maxDollars: 10.00, maxSteps: 50 }) },
);

if (result.ok) {
  console.log('Review:', result.value.message.content);
}
```

`orchestratorAgent` returns a function with the signature:

```ts
(prompt: string, opts?: { budget?: Budget; model?: string }) => ReturnType<typeof agent>
```

## Full example: tool + event logging

```ts
import { agent } from 'flint';
import { budget } from 'flint/budget';
import {
  fileJournalStore,
  workflowTool,
  WORKFLOW_TOOL_GUIDE,
} from '@flint/landlord';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import { join } from 'node:path';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });
const journal = fileJournalStore(join(process.cwd(), '.workflow-journal'));

const wfTool = workflowTool({
  adapter,
  models: { default: 'claude-opus-4-7' },
  journal,
  onEvent: (e) => {
    if (e.type === 'phase_started') console.log(`\n[${e.title}]`);
    if (e.type === 'agent_started') console.log(`  → ${e.label} (${e.model})`);
    if (e.type === 'agent_complete') console.log(`  ✓ ${e.label} (${e.tokens} tokens)`);
    if (e.type === 'workflow_complete') console.log('\n[Done]');
  },
});

const result = await agent({
  adapter,
  model: 'claude-opus-4-7',
  messages: [
    { role: 'system', content: WORKFLOW_TOOL_GUIDE },
    {
      role: 'user',
      content:
        'Review src/ for security issues using parallel scanners, ' +
        'then verify each finding with an independent agent.',
    },
  ],
  tools: [wfTool],
  budget: budget({ maxSteps: 30, maxDollars: 8.00 }),
});

if (!result.ok) {
  console.error('Agent failed:', result.error.message);
} else {
  console.log('\nAgent response:\n', result.value.message.content);
}
```

## Registered workflows

Pass a `WorkflowRegistry` to `workflowTool` to let the model (or agent) run named workflows by name instead of writing a script every time:

```ts
import { createWorkflowRegistry, workflowTool } from '@flint/landlord';

const source = `
export const meta = { name: 'security-scan', description: 'Run a security scan' }
const targets = args ?? ['src/']
const results = await parallel(targets.map(t => () => agent('Scan ' + t + ' for vulnerabilities')))
return results.filter(Boolean)
`;

const workflows = createWorkflowRegistry({ 'security-scan': source });

const wfTool = workflowTool({
  adapter,
  models: { default: 'claude-opus-4-7' },
  workflows,
});

// The model can now call the tool with { name: 'security-scan', args: ['src/', 'tests/'] }
```

## See also

- [Workflow Runtime](/landlord/workflow) — `runWorkflow`, `runWorkflowScript`, `RuntimeConfig`
- [Hooks reference](/landlord/hooks) — the full hook API the model has access to
- [Resume and journaling](/landlord/resume) — `resumeFromRunId` for model-authored workflow recovery
- [Dynamic Workflow Example](/examples/dynamic-workflow) — complete end-to-end example
