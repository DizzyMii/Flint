// test/workflow/registry.test.ts
import { describe, expect, it } from 'vitest';
import { WorkflowError } from '../../src/workflow/errors.ts';
import { createAgentRegistry, createWorkflowRegistry } from '../../src/workflow/registry.ts';

describe('createAgentRegistry', () => {
  it('resolves built-in types', () => {
    const reg = createAgentRegistry();
    expect(reg.has('default')).toBe(true);
    expect(reg.has('Explore')).toBe(true);
    expect(reg.has('code-reviewer')).toBe(true);
    expect(reg.resolve('default').tools?.('/tmp/x').length).toBeGreaterThan(0);
  });

  it('merges custom types over built-ins and throws on unknown', () => {
    const reg = createAgentRegistry({ custom: { systemPrompt: 'You are custom.' } });
    expect(reg.resolve('custom').systemPrompt).toBe('You are custom.');
    expect(() => reg.resolve('missing')).toThrow(WorkflowError);
  });
});

describe('createWorkflowRegistry', () => {
  it('resolves named sources', () => {
    const reg = createWorkflowRegistry({ greet: 'return "hi"' });
    expect(reg.resolve('greet')).toBe('return "hi"');
    expect(reg.resolve('nope')).toBeUndefined();
  });
});
