// test/workflow/budget.test.ts
import { describe, expect, it } from 'vitest';
import { WorkflowBudget, budgetView } from '../../src/workflow/budget.ts';

describe('WorkflowBudget', () => {
  it('tracks spent output tokens and computes remaining against a target', () => {
    const wb = new WorkflowBudget(100);
    wb.record({ input: 10, output: 30 });
    wb.record({ input: 5, output: 20 });
    expect(wb.spent()).toBe(50);
    expect(wb.remaining()).toBe(50);
  });

  it('remaining is Infinity when total is null', () => {
    const wb = new WorkflowBudget(null);
    wb.record({ output: 1000 });
    expect(wb.spent()).toBe(1000);
    expect(wb.remaining()).toBe(Number.POSITIVE_INFINITY);
  });

  it('budgetView exposes total/spent/remaining bound to the instance', () => {
    const wb = new WorkflowBudget(10);
    const view = budgetView(wb);
    wb.record({ output: 4 });
    expect(view.total).toBe(10);
    expect(view.spent()).toBe(4);
    expect(view.remaining()).toBe(6);
  });
});
