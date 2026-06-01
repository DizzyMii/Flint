import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, Result } from 'flint';
import { budget as makeBudget } from 'flint/budget';
import type { Budget } from 'flint/budget';
import type { RunDeps } from './agentcall.ts';
import { WorkflowBudget } from './budget.ts';
import { AgentCounter, Semaphore, defaultConcurrency } from './concurrency.ts';
import { WorkflowError } from './errors.ts';
import { EventEmitter } from './events.ts';
import type { EventSink } from './events.ts';
import { buildContext } from './hooks.ts';
import { gitWorktreeIsolation, workdirIsolation } from './isolation.ts';
import type { IsolationBackend } from './isolation.ts';
import { memoryJournalStore } from './journal.ts';
import type { JournalStore } from './journal.ts';
import { createAgentRegistry } from './registry.ts';
import type { AgentTypeRegistry, WorkflowRegistry } from './registry.ts';
import { compileScript } from './script.ts';
import type { Models, WorkflowContext, WorkflowModule, WorkflowRunResult } from './types.ts';

export type RuntimeConfig = {
  adapter: ProviderAdapter;
  models: Models;
  args?: unknown;
  budget?: Budget;
  tokenTarget?: number | null;
  registry?: AgentTypeRegistry;
  workflows?: WorkflowRegistry;
  journal?: JournalStore;
  isolation?: IsolationBackend;
  worktreeRepoDir?: string;
  baseDir?: string;
  concurrency?: number;
  agentCap?: number;
  onEvent?: EventSink;
  signal?: AbortSignal;
  runId?: string;
  resumeFromRunId?: string;
};

async function buildDeps(config: RuntimeConfig): Promise<RunDeps> {
  const runId = config.runId ?? randomUUID().slice(0, 8);
  const baseDir = config.baseDir ?? join(tmpdir(), `flint-workflow-${runId}`);
  await mkdir(baseDir, { recursive: true });
  const journal = config.journal ?? memoryJournalStore();
  const resumeEntries =
    config.resumeFromRunId !== undefined ? await journal.load(config.resumeFromRunId) : [];
  let index = 0;
  return {
    adapter: config.adapter,
    models: config.models,
    flintBudget: config.budget ?? makeBudget({ maxSteps: 1_000_000 }),
    wfBudget: new WorkflowBudget(config.tokenTarget ?? null),
    semaphore: new Semaphore(config.concurrency ?? defaultConcurrency()),
    counter: new AgentCounter(config.agentCap ?? 1000),
    registry: config.registry ?? createAgentRegistry(),
    workflows: config.workflows,
    isolation: config.isolation ?? workdirIsolation(baseDir),
    ...(config.worktreeRepoDir !== undefined
      ? { worktreeIsolation: gitWorktreeIsolation(config.worktreeRepoDir, baseDir) }
      : { worktreeIsolation: undefined }),
    emitter: new EventEmitter(config.onEvent),
    journal,
    runId,
    resumeEntries,
    ...(config.signal !== undefined ? { signal: config.signal } : { signal: undefined }),
    args: config.args,
    depth: 0,
    nextIndex: () => index++,
    currentPhase: { value: undefined },
  };
}

function resolveSource(
  ref: string | { scriptPath?: string; source?: string },
  workflows: WorkflowRegistry | undefined,
): string {
  if (typeof ref === 'string') {
    const src = workflows?.resolve(ref);
    if (src === undefined) throw new WorkflowError(`Unknown workflow '${ref}'`, 'workflow.unknown');
    return src;
  }
  if (ref.source !== undefined) return ref.source;
  throw new WorkflowError(
    'workflow(): provide a registered name or { source }; { scriptPath } must be read by the caller.',
    'workflow.unknown',
  );
}

function executeModule(module: WorkflowModule, deps: RunDeps): Promise<unknown> {
  const workflowFn: WorkflowContext['workflow'] = async (ref, childArgs) => {
    if (deps.depth >= 1) {
      throw new WorkflowError('workflow() nesting is one level only', 'workflow.nesting');
    }
    const child = compileScript(resolveSource(ref, deps.workflows));
    return executeModule(child, { ...deps, depth: deps.depth + 1, args: childArgs });
  };
  return module.run(buildContext(deps, workflowFn));
}

export async function runWorkflow(
  module: WorkflowModule,
  config: RuntimeConfig,
): Promise<Result<WorkflowRunResult>> {
  const deps = await buildDeps(config);
  try {
    const result = await executeModule(module, deps);
    deps.emitter.emit({ type: 'workflow_complete', result });
    return { ok: true, value: { runId: deps.runId, result, events: deps.emitter.all() } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

export async function runWorkflowScript(
  source: string,
  config: RuntimeConfig,
): Promise<Result<WorkflowRunResult>> {
  let module: WorkflowModule;
  try {
    module = compileScript(source);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }
  return runWorkflow(module, config);
}
