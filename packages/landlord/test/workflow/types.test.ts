// test/workflow/types.test.ts
import { describe, expect, it } from 'vitest';
import { AgentCapError, MetaError, WorkflowError } from '../../src/workflow/errors.ts';

describe('workflow errors', () => {
  it('WorkflowError carries a code and name', () => {
    const e = new WorkflowError('boom', 'workflow.test');
    expect(e.code).toBe('workflow.test');
    expect(e.name).toBe('WorkflowError');
    expect(e).toBeInstanceOf(Error);
  });

  it('AgentCapError and MetaError have fixed codes', () => {
    expect(new AgentCapError('x').code).toBe('workflow.agent_cap');
    expect(new MetaError('x').code).toBe('workflow.meta');
  });
});
