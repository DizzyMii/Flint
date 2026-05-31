// test/workflow/schema.test.ts
import { execute } from 'flint';
import { describe, expect, it } from 'vitest';
import { makeStructuredOutput } from '../../src/workflow/schema.ts';

describe('makeStructuredOutput', () => {
  it('captures a valid object and reports success', async () => {
    const so = makeStructuredOutput({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    const res = await execute(so.tool, { name: 'ada' });
    expect(res.ok).toBe(true);
    expect(so.getValue()).toEqual({ name: 'ada' });
  });

  it('rejects an invalid object and leaves value undefined', async () => {
    const so = makeStructuredOutput({
      type: 'object',
      properties: { n: { type: 'number' } },
      required: ['n'],
    });
    const res = await execute(so.tool, { n: 'not-a-number' });
    expect(res.ok).toBe(true); // handler returns an error string, not a thrown error
    expect(String(res.ok ? res.value : '')).toMatch(/does not match/i);
    expect(so.getValue()).toBeUndefined();
  });

  it('wraps non-object schemas under a result key and unwraps the captured value', async () => {
    const so = makeStructuredOutput({ type: 'array', items: { type: 'string' } });
    await execute(so.tool, { result: ['a', 'b'] });
    expect(so.getValue()).toEqual(['a', 'b']);
  });
});
