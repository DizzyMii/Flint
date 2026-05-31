import { describe, expect, it } from 'vitest';
import { MetaError } from '../../src/workflow/errors.ts';
import { parseMeta } from '../../src/workflow/meta.ts';

describe('parseMeta', () => {
  it('parses a pure object literal with nested arrays', () => {
    const meta = parseMeta(
      `export const meta = { name: 'rev', description: "Review", phases: [{ title: 'A' }, { title: 'B', detail: 'x' }] }\nphase('A')`,
    );
    expect(meta.name).toBe('rev');
    expect(meta.description).toBe('Review');
    expect(meta.phases).toEqual([{ title: 'A' }, { title: 'B', detail: 'x' }]);
  });

  it('rejects a non-literal value (function call) in meta', () => {
    expect(() => parseMeta(`export const meta = { name: foo(), description: 'x' }`)).toThrow(
      MetaError,
    );
  });

  it('rejects meta missing name/description', () => {
    expect(() => parseMeta(`export const meta = { name: 'x' }`)).toThrow(MetaError);
  });
});
