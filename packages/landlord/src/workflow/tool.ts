import { agent, tool } from 'flint';
import type { ProviderAdapter, Result, Tool } from 'flint';
import { budget as makeBudget } from 'flint/budget';
import type { Budget } from 'flint/budget';
import { z } from 'zod';
import type { EventSink } from './events.ts';
import type { IsolationBackend } from './isolation.ts';
import type { JournalStore } from './journal.ts';
import type { AgentTypeRegistry, WorkflowRegistry } from './registry.ts';
import { runWorkflowScript } from './runtime.ts';
import type { RuntimeConfig } from './runtime.ts';
import type { Models } from './types.ts';

export type WorkflowToolConfig = {
  adapter: ProviderAdapter;
  models: Models;
  registry?: AgentTypeRegistry;
  workflows?: WorkflowRegistry;
  journal?: JournalStore;
  isolation?: IsolationBackend;
  onEvent?: EventSink;
};

const workflowToolSchema = z.object({
  script: z.string().optional(),
  args: z.unknown().optional(),
  name: z.string().optional(),
  resumeFromRunId: z.string().optional(),
});

const WORKFLOW_TOOL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    script: {
      type: 'string',
      description: 'A workflow JS script beginning with `export const meta = { ... }`.',
    },
    args: { description: 'Optional value exposed to the script as `args`.' },
    name: {
      type: 'string',
      description: 'Name of a registered workflow to run instead of `script`.',
    },
    resumeFromRunId: {
      type: 'string',
      description: 'Resume a prior run, replaying unchanged agents.',
    },
  },
};

export function workflowTool(config: WorkflowToolConfig): Tool {
  return tool({
    name: 'workflow',
    description:
      'Author and run a dynamic multi-agent workflow. Provide a `script` that orchestrates ' +
      'subagents with agent()/parallel()/pipeline()/phase()/log()/budget()/workflow(). ' +
      'Returns JSON { runId, result }.',
    input: workflowToolSchema,
    jsonSchema: WORKFLOW_TOOL_JSON_SCHEMA,
    handler: async (input) => {
      let source = input.script;
      if (source === undefined && input.name !== undefined) {
        source = config.workflows?.resolve(input.name);
      }
      if (source === undefined) {
        return 'Error: provide either a `script` string or a registered `name`.';
      }
      const runtimeConfig: RuntimeConfig = {
        adapter: config.adapter,
        models: config.models,
        ...(config.registry !== undefined ? { registry: config.registry } : {}),
        ...(config.workflows !== undefined ? { workflows: config.workflows } : {}),
        ...(config.journal !== undefined ? { journal: config.journal } : {}),
        ...(config.isolation !== undefined ? { isolation: config.isolation } : {}),
        ...(config.onEvent !== undefined ? { onEvent: config.onEvent } : {}),
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.resumeFromRunId !== undefined ? { resumeFromRunId: input.resumeFromRunId } : {}),
      };
      const res = await runWorkflowScript(source, runtimeConfig);
      if (!res.ok) return `Error: ${res.error.message}`;
      return JSON.stringify({ runId: res.value.runId, result: res.value.result });
    },
  }) as unknown as Tool;
}

export function orchestratorAgent(config: WorkflowToolConfig) {
  const wt = workflowTool(config);
  return (prompt: string, opts?: { budget?: Budget; model?: string }): ReturnType<typeof agent> =>
    agent({
      adapter: config.adapter,
      model: opts?.model ?? config.models.default,
      messages: [
        { role: 'system', content: WORKFLOW_TOOL_GUIDE },
        { role: 'user', content: prompt },
      ],
      tools: [wt],
      budget: opts?.budget ?? makeBudget({ maxSteps: 50 }),
    });
}

export const WORKFLOW_TOOL_GUIDE = `You can orchestrate subagents by writing a workflow script and running it with the \`workflow\` tool.

A script begins with a pure-literal meta block, then a body using injected hooks:

  export const meta = { name: 'review', description: 'Review changes and verify findings' }
  phase('Find')
  const findings = await parallel(FINDERS.map(f => () => agent(f.prompt, { schema: FINDINGS })))
  return findings.flat().filter(Boolean)

Hooks available in the script:
- agent(prompt, opts?) — spawn a subagent. Without a schema it returns the agent's final text; with { schema } (a JSON Schema) it is forced to return a validated object. opts: { label, phase, schema, model, isolation: 'worktree', agentType }.
- parallel(thunks) — run thunks concurrently. This is a BARRIER: it awaits all of them. A thunk that throws becomes null in the result array, so filter(Boolean) before use.
- pipeline(items, ...stages) — run each item through every stage independently, with NO barrier between stages. Each stage receives (prevResult, originalItem, index). A throwing stage drops that item to null. This is the DEFAULT for multi-stage work.
- phase(title) / log(message) — progress grouping and narration.
- args — the input value passed to the run.
- budget — { total, spent(), remaining() } in output tokens; total may be null. Use for loops: while (budget.total && budget.remaining() > 50000) { ... }.
- workflow(nameOrRef, args?) — run another registered workflow inline (one level only).

Determinism: Date.now(), new Date(), and Math.random() are unavailable inside scripts (they throw) so runs can be resumed. Pass timestamps via args; vary by index for pseudo-randomness.

Concurrency is capped automatically; the total number of agents per run is capped at 1000.

Default to pipeline() — only use a barrier (parallel between stages) when stage N genuinely needs all of stage N-1's results at once (dedup/merge, early-exit on zero, cross-item comparison).

Quality patterns to compose as the task warrants:
- Adversarial verify: spawn independent skeptics per finding, each prompted to REFUTE; keep only findings that survive a majority.
- Judge panel: generate N independent attempts from different angles, score with parallel judges, synthesize from the winner.
- Loop-until-dry: keep spawning finders until K consecutive rounds surface nothing new.
- Multi-modal sweep: parallel agents each searching a different way; each blind to the others.
- Completeness critic: a final agent that asks "what's missing?" — its answer becomes the next round of work.

Scale effort to the request: a quick check needs a few agents and single-vote verification; "thoroughly audit this" warrants a larger finder pool plus a 3–5 vote adversarial pass and a synthesis stage.`;
