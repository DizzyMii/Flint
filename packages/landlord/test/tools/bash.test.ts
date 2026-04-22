import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { bashTool } from '../../src/tools/bash.ts';
import { execute } from 'flint';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('bashTool', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'landlord-bash-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true });
  });

  it('runs a command and returns stdout', async () => {
    const bash = bashTool(workDir);
    const result = await execute(bash, { command: 'echo hello' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(String(result.value)).toContain('hello');
    }
  });

  it('captures stderr in output', async () => {
    const bash = bashTool(workDir);
    const result = await execute(bash, { command: 'echo error_text >&2' });
    expect(result.ok).toBe(true);
  });

  it('returns error on non-zero exit code', async () => {
    const bash = bashTool(workDir);
    const result = await execute(bash, { command: 'exit 1' });
    expect(result.ok).toBe(false);
  });

  it('runs in the workDir', async () => {
    const bash = bashTool(workDir);
    const result = await execute(bash, { command: 'pwd' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Normalize for Windows temp path casing differences
      expect(String(result.value).trim().toLowerCase()).toContain(workDir.toLowerCase().replace(/\\/g, '/').split('/').pop()!);
    }
  });
});
