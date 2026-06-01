// src/workflow/types.ts
import type { ProviderAdapter, Tool } from 'flint';

export type Models = { default: string } & Record<string, string>;

export type AgentOpts = {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  model?: string;
  isolation?: 'worktree';
  agentType?: string;
};

export type StageFn = (
  prev: unknown,
  originalItem: unknown,
  index: number,
) => unknown | Promise<unknown>;

export type WorkflowBudgetView = {
  total: number | null;
  spent: () => number;
  remaining: () => number;
};

export type WorkflowContext = {
  agent: (prompt: string, opts?: AgentOpts) => Promise<unknown>;
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>;
  pipeline: (items: unknown[], ...stages: StageFn[]) => Promise<unknown[]>;
  phase: (title: string) => void;
  log: (message: string) => void;
  args: unknown;
  budget: WorkflowBudgetView;
  workflow: (
    ref: string | { scriptPath?: string; source?: string },
    args?: unknown,
  ) => Promise<unknown>;
};

export type WorkflowEvent =
  | { type: 'phase_started'; title: string }
  | { type: 'log'; message: string }
  | { type: 'agent_started'; label: string; phase?: string; agentType: string; model: string }
  | { type: 'agent_complete'; label: string; phase?: string; tokens: number }
  | { type: 'agent_error'; label: string; phase?: string; error: string }
  | { type: 'workflow_complete'; result: unknown };

export type MetaPhase = { title: string; detail?: string; model?: string };

export type Meta = {
  name: string;
  description: string;
  whenToUse?: string;
  model?: string;
  phases?: MetaPhase[];
};

export type WorkflowModule = {
  meta: Meta;
  run: (wf: WorkflowContext) => Promise<unknown>;
};

export type WorkflowRunResult = {
  runId: string;
  result: unknown;
  events: WorkflowEvent[];
};

// Re-exported here so consumers can build tool registries without importing flint directly.
export type { ProviderAdapter, Tool };
