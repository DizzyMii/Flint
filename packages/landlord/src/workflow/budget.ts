// src/workflow/budget.ts
import type { WorkflowBudgetView } from './types.ts';

/**
 * Tracks the run's output-token spend against an optional target (the ultracode
 * "+500k"-style ceiling). `total === null` means no target → unbounded remaining.
 */
export class WorkflowBudget {
  private outputTokens = 0;
  readonly total: number | null;

  constructor(total: number | null) {
    this.total = total;
  }

  record(usage: { input?: number; output?: number; cached?: number }): void {
    this.outputTokens += usage.output ?? 0;
  }

  spent(): number {
    return this.outputTokens;
  }

  remaining(): number {
    return this.total === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.total - this.outputTokens);
  }
}

export function budgetView(wb: WorkflowBudget): WorkflowBudgetView {
  return {
    total: wb.total,
    spent: () => wb.spent(),
    remaining: () => wb.remaining(),
  };
}
