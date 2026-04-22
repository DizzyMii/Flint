import { describe, expect, it, vi, afterEach } from 'vitest';
import { webFetchTool } from '../../src/tools/web.ts';
import { execute } from 'flint';

describe('webFetchTool', () => {
  afterEach(() => { vi.restoreAllMocks() });

  it('returns response body as string', async () => {
    vi.stubGlobal('fetch', async (_url: string) => ({
      ok: true,
      text: async () => '<html>Hello</html>',
    }));

    const web = webFetchTool('/tmp/workdir');
    const result = await execute(web, { url: 'https://example.com' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(String(result.value)).toContain('Hello');
    }
  });

  it('returns error on non-ok response', async () => {
    vi.stubGlobal('fetch', async (_url: string) => ({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    }));

    const web = webFetchTool('/tmp/workdir');
    const result = await execute(web, { url: 'https://example.com/missing' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error.cause as Error).message).toMatch(/404/);
    }
  });

  it('returns error on network failure', async () => {
    vi.stubGlobal('fetch', async (_url: string) => { throw new Error('ECONNREFUSED') });

    const web = webFetchTool('/tmp/workdir');
    const result = await execute(web, { url: 'https://unreachable.example' });

    expect(result.ok).toBe(false);
  });
});
