# Isolation

Every `agent()` call in a workflow gets an isolated work directory. This keeps agents from accidentally reading each other's partial outputs or writing to shared paths. The `IsolationBackend` interface controls how that directory is provisioned and cleaned up.

## Type definitions

```ts
type IsolationLease = {
  workDir: string;
  release: () => Promise<void>;
};

interface IsolationBackend {
  acquire(label: string): Promise<IsolationLease>;
}
```

`acquire` receives the agent's label (sanitized to alphanumeric + `_-`, max 40 characters) and returns a lease containing the path to use. `release` is called after the agent loop finishes — whether it succeeded or threw.

## `workdirIsolation(baseDir)` — default

Creates a fresh subdirectory under `baseDir` for each agent. Directory names are `<sanitized-label>-<counter>`. `release` is a no-op (the directory is kept for inspection after the run).

This is the default backend used by all agents unless overridden.

```ts
import { runWorkflow, workdirIsolation } from '@flint/landlord';
import { join } from 'node:path';

// Explicit — use a specific base directory
const result = await runWorkflow(workflow, {
  adapter,
  models: { default: 'claude-opus-4-7' },
  isolation: workdirIsolation(join(process.cwd(), 'agent-workdirs')),
});
```

If you don't pass `isolation`, the runtime creates a `workdirIsolation` in `os.tmpdir()/flint-workflow-<runId>/` automatically.

## `gitWorktreeIsolation(repoDir, baseDir)` — optional

Creates a git worktree per agent via `git worktree add --detach`. Each agent gets a clean checkout of `HEAD` to work in. `release` runs `git worktree remove --force` after the agent finishes.

**Requires** a git repository at `repoDir`. Outside a git repo, `gitWorktreeIsolation` falls back silently to `workdirIsolation(baseDir)`.

Enable it for all agents by setting `worktreeRepoDir` in `RuntimeConfig`, or per-agent with `isolation: 'worktree'` in `AgentOpts`:

```ts
import { defineWorkflow, runWorkflow } from '@flint/landlord';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const workflow = defineWorkflow({
  meta: { name: 'parallel-edits', description: 'Edit files in parallel worktrees' },
  run: async (wf) => {
    // These two agents each get their own git worktree
    const [resultA, resultB] = await wf.parallel([
      () => wf.agent('Refactor src/auth.ts to use async/await throughout', {
        isolation: 'worktree',
        label: 'refactor-auth',
      }),
      () => wf.agent('Add JSDoc comments to src/api.ts', {
        isolation: 'worktree',
        label: 'jsdoc-api',
      }),
    ]);
    return { resultA, resultB };
  },
});

const result = await runWorkflow(workflow, {
  adapter,
  models: { default: 'claude-opus-4-7' },
  // Enable the worktree backend for agents that use isolation: 'worktree'
  worktreeRepoDir: process.cwd(),
});
```

## When to use `isolation: 'worktree'`

Use a git worktree when:

- Agents will modify files and you want each agent to start from a clean copy of `HEAD`.
- You need to diff or merge the agent's changes after it finishes.
- Agents running in parallel would otherwise conflict on the same files.

Use the default `workdirIsolation` when:

- Agents are read-only (search, analysis, code review).
- You want agents to read from the real working tree without copying it.
- You are not in a git repository.

## Bringing a custom backend

Any object with an `acquire(label)` method that returns `{ workDir, release }` works:

```ts
import type { IsolationBackend } from '@flint/landlord';

// Example: always use /tmp/shared-workdir (single shared dir — not recommended for parallel agents)
const sharedDirBackend: IsolationBackend = {
  acquire: async () => ({
    workDir: '/tmp/shared-workdir',
    release: async () => {},
  }),
};

await runWorkflow(workflow, {
  adapter,
  models: { default: 'claude-opus-4-7' },
  isolation: sharedDirBackend,
});
```

## See also

- [Workflow Runtime](/landlord/workflow) — `RuntimeConfig.isolation`, `RuntimeConfig.worktreeRepoDir`
- [Hooks reference](/landlord/hooks) — `AgentOpts.isolation`
- [Agent Types](/landlord/agent-types) — tool sets that use `workDir`
