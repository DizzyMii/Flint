import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileReadTool, fileWriteTool } from '../src/tools/file.ts';
import { compileScript } from '../src/workflow/script.ts';

async function run(t: ReturnType<typeof fileReadTool>, input: unknown) {
  try {
    return { ok: true, value: await t.handler(input, { signal: new AbortController().signal }) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

describe('file tool containment', () => {
  it('rejects traversal and symlink escapes but allows names starting with dots', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    await writeFile(join(outside, 'secret'), 's3cret');
    const work = await mkdtemp(join(tmpdir(), 'work-'));
    await symlink(outside, join(work, 'link'));
    const read = fileReadTool(work);
    expect((await run(read, { path: '../x' })).ok).toBe(false);
    expect((await run(read, { path: join(outside, 'secret') })).ok).toBe(false);
    expect((await run(read, { path: 'link/secret' })).ok).toBe(false);
    expect((await run(fileWriteTool(work), { path: 'link/new', content: 'x' })).ok).toBe(false);
    expect((await run(fileWriteTool(work), { path: '..notparent', content: 'x' })).ok).toBe(true);
  });
});

describe('workflow script guard', () => {
  it('blocks accidental nondeterminism', async () => {
    const mod = compileScript(
      "export const meta = { name: 'x', description: 'x' };\nexport default Date.now();",
    );
    await expect(mod.run({} as never)).rejects.toThrow(/not available/);
  });

  it('is documented as not a security boundary (constructor chain reaches the host)', async () => {
    const mod = compileScript(
      "export const meta = { name: 'x', description: 'x' };\nexport default (async () => {}).constructor('return typeof process')();",
    );
    // If this ever starts failing, the guard became a real boundary: update docs/landlord/workflow.md.
    expect(await mod.run({} as never)).toBe('object');
  });
});
