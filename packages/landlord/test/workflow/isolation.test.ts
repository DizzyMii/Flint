// test/workflow/isolation.test.ts
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitWorktreeIsolation, workdirIsolation } from '../../src/workflow/isolation.ts';

describe('workdirIsolation', () => {
  it('creates a distinct existing directory per acquire', async () => {
    const base = await mkdtemp(join(tmpdir(), 'iso-'));
    const backend = workdirIsolation(base);
    const a = await backend.acquire('alpha');
    const b = await backend.acquire('alpha');
    expect(a.workDir).not.toBe(b.workDir);
    expect((await stat(a.workDir)).isDirectory()).toBe(true);
    await a.release();
    await b.release();
  });
});

describe('gitWorktreeIsolation', () => {
  it('falls back to a workdir lease outside a git repo', async () => {
    const base = await mkdtemp(join(tmpdir(), 'iso2-'));
    const notRepo = await mkdtemp(join(tmpdir(), 'norepo-'));
    const backend = gitWorktreeIsolation(notRepo, base);
    const lease = await backend.acquire('w');
    expect((await stat(lease.workDir)).isDirectory()).toBe(true);
    await lease.release();
  });
});
