import { describe, expect, it } from 'vitest';
import { resolveOrder, DependencyCycleError } from '../src/orchestrate.ts';
import type { Contract } from '../src/contract.ts';

function makeContract(role: string, dependsOn: string[] = []): Contract {
  return {
    tenantId: role,
    role,
    objective: `Do ${role}`,
    subPrompt: `Do ${role}`,
    checkpoints: [],
    outputSchema: {},
    dependsOn,
    maxRetries: 3,
  };
}

describe('resolveOrder', () => {
  it('returns single contract unchanged', () => {
    const contracts = [makeContract('a')];
    const order = resolveOrder(contracts);
    expect(order.map(c => c.role)).toEqual(['a']);
  });

  it('orders a → b (b depends on a)', () => {
    const contracts = [makeContract('b', ['a']), makeContract('a')];
    const order = resolveOrder(contracts);
    const roles = order.map(c => c.role);
    expect(roles.indexOf('a')).toBeLessThan(roles.indexOf('b'));
  });

  it('orders a → b → c chain', () => {
    const contracts = [makeContract('c', ['b']), makeContract('a'), makeContract('b', ['a'])];
    const order = resolveOrder(contracts);
    const roles = order.map(c => c.role);
    expect(roles.indexOf('a')).toBeLessThan(roles.indexOf('b'));
    expect(roles.indexOf('b')).toBeLessThan(roles.indexOf('c'));
  });

  it('throws DependencyCycleError on cycle', () => {
    const contracts = [makeContract('a', ['b']), makeContract('b', ['a'])];
    expect(() => resolveOrder(contracts)).toThrow(DependencyCycleError);
  });

  it('ignores depends_on references to unknown roles', () => {
    const contracts = [makeContract('a', ['nonexistent'])];
    expect(() => resolveOrder(contracts)).not.toThrow();
  });
});
