# Agent Types

Every `agent()` call resolves an **agent type** — a preset that supplies a system prompt, a default tool set, and an optional model override. The `agentType` field on `AgentOpts` selects the preset; `'default'` is used when unset.

## Type definitions

```ts
type AgentType = {
  systemPrompt: string;
  tools?: (workDir: string) => Tool[];
  model?: string;
};

type AgentTypeRegistry = {
  resolve(name: string): AgentType;
  has(name: string): boolean;
};
```

## Built-in types

| Name | Tools | System prompt focus |
|------|-------|---------------------|
| `'default'` | `standardTools(workDir)` (file read/write, bash, web fetch) | General worker; returns structured results via `structured_output` tool when a schema is requested |
| `'Explore'` | `fileReadTool(workDir)`, `webFetchTool(workDir)` | Read-only exploration; searches broadly, returns conclusions, never modifies files |
| `'code-reviewer'` | `fileReadTool(workDir)`, `bashTool(workDir)` | Code review; reports concrete issues with file and line references |

All three are available from `BUILT_IN_AGENT_TYPES` if you need to inspect them:

```ts
import { BUILT_IN_AGENT_TYPES } from '@flint/landlord';

console.log(BUILT_IN_AGENT_TYPES.Explore.systemPrompt);
```

## Using built-in types

```ts
import { defineWorkflow, runWorkflow } from '@flint/landlord';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const workflow = defineWorkflow({
  meta: { name: 'review', description: 'Explore then review' },
  run: async (wf) => {
    wf.phase('Explore');
    // Read-only agent — no write tools
    const overview = await wf.agent('Map out the codebase structure', {
      agentType: 'Explore',
    });

    wf.phase('Review');
    // Code reviewer — file read + bash tools, review-focused system prompt
    const review = await wf.agent(
      `Review the code described here: ${String(overview)}`,
      { agentType: 'code-reviewer', label: 'code-review' },
    );

    return { overview, review };
  },
});

const result = await runWorkflow(workflow, {
  adapter,
  models: { default: 'claude-opus-4-7' },
});
```

## Composing `agentType` with `schema`

When `schema` is set alongside `agentType`, the preset's system prompt is used and the structured-output instruction is appended to it. The preset's tools are used as the base tool set, and the forced `structured_output` tool is added on top.

```ts
const findings = await wf.agent('Find security issues in src/auth.ts', {
  agentType: 'code-reviewer',
  schema: {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'number' },
            description: { type: 'string' },
          },
          required: ['file', 'description'],
        },
      },
    },
    required: ['issues'],
  },
});
// findings is { issues: Array<{ file: string; line?: number; description: string }> }
// The code-reviewer system prompt + structured_output instruction were used
```

## Custom agent types

Pass a `Record<string, AgentType>` to `createAgentRegistry` to add or override types. Custom types are merged over the built-ins.

```ts
import {
  createAgentRegistry,
  defineWorkflow,
  runWorkflow,
} from '@flint/landlord';
import { bashTool, fileReadTool } from '@flint/landlord/tools';

const registry = createAgentRegistry({
  'security-auditor': {
    systemPrompt:
      'You are a security auditor specializing in OWASP Top 10. ' +
      'Read code carefully. Report only confirmed vulnerabilities — no false positives. ' +
      'When returning structured output, always include severity and cve reference if known.',
    tools: (workDir) => [fileReadTool(workDir), bashTool(workDir)],
    model: 'claude-opus-4-7', // this type always uses Opus regardless of models.default
  },
  'doc-writer': {
    systemPrompt:
      'You are a technical writer. Write clear, concise documentation. ' +
      'Use plain language and include runnable code examples.',
    // No tools override — falls back to standardTools(workDir)
  },
});

const workflow = defineWorkflow({
  meta: { name: 'security-review', description: 'Security-focused review' },
  run: async (wf) => {
    return wf.agent('Audit src/ for OWASP vulnerabilities', {
      agentType: 'security-auditor',
    });
  },
});

await runWorkflow(workflow, {
  adapter,
  models: { default: 'claude-haiku-4-5' },
  registry, // security-auditor will still use claude-opus-4-7 due to its preset model
});
```

## Per-agent model override

`opts.model` takes priority over the preset's model which takes priority over `models.default`:

```
opts.model  >  preset.model  >  config.models.default
```

Use named tiers in `models` to manage fast/slow variants:

```ts
await runWorkflow(workflow, {
  adapter,
  models: { default: 'claude-opus-4-7', fast: 'claude-haiku-4-5' },
});

// Inside the workflow:
const quick = await wf.agent('Quick check', { model: 'claude-haiku-4-5' });
```

## See also

- [Hooks reference](/landlord/hooks) — `agent()` and `AgentOpts` full reference
- [Isolation](/landlord/isolation) — per-agent work directory backends
- [Workflow Runtime](/landlord/workflow) — `RuntimeConfig.registry` field
