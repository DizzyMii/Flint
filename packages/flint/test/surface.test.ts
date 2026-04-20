import { describe, expect, it } from 'vitest';

describe('flint package', () => {
  it('imports without error', async () => {
    const mod = await import('../src/index.ts');
    expect(mod).toBeDefined();
  });
});
