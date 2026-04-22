import type { Contract } from './contract.ts';

export class DependencyCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyCycleError';
  }
}

export function resolveOrder(contracts: Contract[]): Contract[] {
  const byRole = new Map(contracts.map(c => [c.role, c]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(contracts.map(c => [c.role, WHITE]));
  const order: Contract[] = [];

  function visit(role: string, stack: string[]): void {
    if (color.get(role) === GRAY) {
      throw new DependencyCycleError(`Dependency cycle: ${[...stack, role].join(' -> ')}`);
    }
    if (color.get(role) === BLACK) return;
    if (!byRole.has(role)) return;
    color.set(role, GRAY);
    for (const dep of byRole.get(role)!.dependsOn) {
      visit(dep, [...stack, role]);
    }
    color.set(role, BLACK);
    order.push(byRole.get(role)!);
  }

  for (const c of contracts) visit(c.role, []);
  return order;
}
