// src/workflow/agentcall.ts
import { agent } from 'flint';
import type { ProviderAdapter } from 'flint';
import type { Budget } from 'flint/budget';
import { standardTools } from '../tools/index.ts';
import type { AgentCounter, Semaphore } from './concurrency.ts';
import type { WorkflowBudget } from './budget.ts';
import { WorkflowError } from './errors.ts';
import type { EventEmitter } from './events.ts';
import { hashCall } from './journal.ts';
import type { JournalEntry, JournalStore } from './journal.ts';
import type { IsolationBackend } from './isolation.ts';
import type { AgentTypeRegistry, WorkflowRegistry } from './registry.ts';
import { makeStructuredOutput } from './schema.ts';
import type { AgentOpts, Models } from './types.ts';

export type RunDeps = {
  adapter: ProviderAdapter;
  models: Models;
  flintBudget: Budget;
  wfBudget: WorkflowBudget;
  semaphore: Semaphore;
  counter: AgentCounter;
  registry: AgentTypeRegistry;
  workflows: WorkflowRegistry | undefined;
  isolation: IsolationBackend;
  worktreeIsolation: IsolationBackend | undefined;
  emitter: EventEmitter;
  journal: JournalStore;
  runId: string;
  resumeEntries: JournalEntry[];
  signal: AbortSignal | undefined;
  args: unknown;
  depth: number;
  nextIndex: () => number;
  currentPhase: { value: string | undefined };
};

export function deriveLabel(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0] ?? prompt;
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
}

export async function runAgentCall(
  prompt: string,
  opts: AgentOpts | undefined,
  deps: RunDeps,
): Promise<unknown> {
  const index = deps.nextIndex();
  const hash = hashCall(prompt, opts ?? {});

  // Resume: replay a cached result when this call's signature is unchanged.
  const cached = deps.resumeEntries.find((e) => e.index === index);
  if (cached !== undefined && cached.hash === hash) {
    return cached.result;
  }

  // Token-target ceiling.
  if (deps.wfBudget.total !== null && deps.wfBudget.remaining() <= 0) {
    throw new WorkflowError(
      `Workflow token target (${deps.wfBudget.total}) reached`,
      'workflow.budget',
    );
  }

  deps.counter.increment();
  const release = await deps.semaphore.acquire();

  const label = opts?.label ?? deriveLabel(prompt);
  const phase = opts?.phase;
  const agentType = opts?.agentType ?? 'default';
  const preset = deps.registry.resolve(agentType);
  const model = opts?.model ?? preset.model ?? deps.models.default;
  const backend =
    opts?.isolation === 'worktree' && deps.worktreeIsolation !== undefined
      ? deps.worktreeIsolation
      : deps.isolation;
  const lease = await backend.acquire(label);

  deps.emitter.emit({
    type: 'agent_started',
    label,
    ...(phase !== undefined ? { phase } : {}),
    agentType,
    model,
  });

  try {
    const baseTools = preset.tools ? preset.tools(lease.workDir) : standardTools(lease.workDir);
    let result: unknown;
    let tokens = 0;

    if (opts?.schema !== undefined) {
      const so = makeStructuredOutput(opts.schema);
      const systemPrompt =
        `${preset.systemPrompt}\n\nYou MUST call the structured_output tool exactly once with your ` +
        'final result as JSON matching the required schema. Do not finish until you have called it.';
      const out = await agent({
        adapter: deps.adapter,
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        tools: [so.tool, ...baseTools],
        budget: deps.flintBudget,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      if (!out.ok) throw out.error;
      deps.wfBudget.record(out.value.usage);
      tokens = out.value.usage.input + out.value.usage.output;
      const value = so.getValue();
      if (value === undefined) {
        throw new WorkflowError(
          `Agent '${label}' finished without producing structured output`,
          'workflow.no_output',
        );
      }
      result = value;
    } else {
      const out = await agent({
        adapter: deps.adapter,
        model,
        messages: [
          { role: 'system', content: preset.systemPrompt },
          { role: 'user', content: prompt },
        ],
        tools: baseTools,
        budget: deps.flintBudget,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      if (!out.ok) throw out.error;
      deps.wfBudget.record(out.value.usage);
      tokens = out.value.usage.input + out.value.usage.output;
      result = out.value.message.content;
    }

    deps.emitter.emit({
      type: 'agent_complete',
      label,
      ...(phase !== undefined ? { phase } : {}),
      tokens,
    });
    await deps.journal.append(deps.runId, { index, hash, result });
    return result;
  } catch (e) {
    deps.emitter.emit({
      type: 'agent_error',
      label,
      ...(phase !== undefined ? { phase } : {}),
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  } finally {
    await lease.release();
    release();
  }
}
