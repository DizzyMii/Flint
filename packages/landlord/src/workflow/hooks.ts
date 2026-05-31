import { runAgentCall } from './agentcall.ts';
import type { RunDeps } from './agentcall.ts';
import { budgetView } from './budget.ts';
import type { AgentOpts, StageFn, WorkflowContext } from './types.ts';

export function buildContext(
  deps: RunDeps,
  workflowFn: WorkflowContext['workflow'],
): WorkflowContext {
  const agent = (prompt: string, opts?: AgentOpts): Promise<unknown> => {
    const phase = opts?.phase ?? deps.currentPhase.value;
    const merged: AgentOpts = { ...(opts ?? {}), ...(phase !== undefined ? { phase } : {}) };
    return runAgentCall(prompt, merged, deps);
  };

  const parallel = async <T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> =>
    Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk();
        } catch {
          return null;
        }
      }),
    );

  const pipeline = async (items: unknown[], ...stages: StageFn[]): Promise<unknown[]> =>
    Promise.all(
      items.map(async (item, index) => {
        let acc: unknown = item;
        for (const stage of stages) {
          try {
            acc = await stage(acc, item, index);
          } catch {
            return null;
          }
        }
        return acc;
      }),
    );

  const phase = (title: string): void => {
    deps.currentPhase.value = title;
    deps.emitter.emit({ type: 'phase_started', title });
  };

  const log = (message: string): void => {
    deps.emitter.emit({ type: 'log', message });
  };

  return {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    args: deps.args,
    budget: budgetView(deps.wfBudget),
    workflow: workflowFn,
  };
}
