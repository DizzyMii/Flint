import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { fileReadTool, fileWriteTool } from '../../src/tools/file.ts';
import { execute } from 'flint';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('fileReadTool / fileWriteTool', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'landlord-test-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true });
  });

  it('writes and reads a file', async () => {
    const write = fileWriteTool(workDir);
    const read = fileReadTool(workDir);

    await execute(write, { path: 'hello.txt', content: 'Hello, world!' });
    const result = await execute(read, { path: 'hello.txt' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('Hello, world!');
    }
  });

  it('fileReadTool returns error for missing file', async () => {
    const read = fileReadTool(workDir);
    const result = await execute(read, { path: 'nonexistent.txt' });
    expect(result.ok).toBe(false);
  });

  it('fileWriteTool rejects path traversal', async () => {
    const write = fileWriteTool(workDir);
    const result = await execute(write, { path: '../escape.txt', content: 'bad' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error.cause as Error).message).toMatch(/outside/i);
    }
  });

  it('fileReadTool rejects path traversal', async () => {
    const read = fileReadTool(workDir);
    const result = await execute(read, { path: '../../etc/passwd' });
    expect(result.ok).toBe(false);
  });

  it('writes files in subdirectories', async () => {
    const write = fileWriteTool(workDir);
    const read = fileReadTool(workDir);

    await execute(write, { path: 'sub/dir/file.ts', content: 'export {}' });
    const result = await execute(read, { path: 'sub/dir/file.ts' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('export {}');
  });
});
