import { describe, expect, it } from 'vitest';
import { requireApproval } from '../../src/safety/require-approval.ts';
import { tool } from '../../src/primitives/tool.ts';
import { execute } from '../../src/primitives/execute.ts';
import { FlintError, ToolError } from '../../src/errors.ts';
import type { StandardSchemaV1 } from '../../src/types.ts';

function anySchema(): StandardSchemaV1<unknown, unknown> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (raw) => ({ value: raw }),
    },
  };
}

const deleteTool = tool({
  name: 'delete',
  description: 'destructive action',
  input: anySchema(),
  handler: () => 'deleted',
  permissions: { destructive: true },
});

describe('requireApproval', () => {
  it('runs handler when onApprove returns true', async () => {
    const wrapped = requireApproval(deleteTool, {
      onApprove: async () => true,
    });
    const res = await execute(wrapped, { id: '1' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBe('deleted');
    }
  });

  it('runs handler when onApprove returns { approved: true }', async () => {
    const wrapped = requireApproval(deleteTool, {
      onApprove: async () => ({ approved: true }),
    });
    const res = await execute(wrapped, { id: '1' });
    expect(res.ok).toBe(true);
  });

  it('rejects tool via ToolError when onApprove returns false', async () => {
    const wrapped = requireApproval(deleteTool, {
      onApprove: async () => false,
    });
    const res = await execute(wrapped, { id: '1' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ToolError);
      // Underlying approval denial is FlintError with tool.approval_denied code
      expect(res.error.cause).toBeInstanceOf(FlintError);
      expect((res.error.cause as FlintError).code).toBe('tool.approval_denied');
    }
  });

  it('includes rejection reason in error message', async () => {
    const wrapped = requireApproval(deleteTool, {
      onApprove: async () => ({ approved: false, reason: 'policy violation' }),
    });
    const res = await execute(wrapped, { id: '1' });
    expect(res.ok).toBe(false);
    if (!res.ok && res.error.cause instanceof FlintError) {
      expect(res.error.cause.message).toContain('policy violation');
    }
  });

  it('passes tool and input to onApprove', async () => {
    let captured: { name?: string; input?: unknown } = {};
    const wrapped = requireApproval(deleteTool, {
      onApprove: async (ctx) => {
        captured = { name: ctx.tool.name, input: ctx.input };
        return true;
      },
    });
    await execute(wrapped, { id: 42 });
    expect(captured.name).toBe('delete');
    expect(captured.input).toEqual({ id: 42 });
  });

  it('sets requireApproval: true on wrapped tool permissions', () => {
    const wrapped = requireApproval(deleteTool, { onApprove: async () => true });
    expect(wrapped.permissions?.requireApproval).toBe(true);
  });

  it('preserves other permission fields on wrapped tool', () => {
    const wrapped = requireApproval(deleteTool, { onApprove: async () => true });
    expect(wrapped.permissions?.destructive).toBe(true);
  });

  it('times out approval after configured duration', async () => {
    const wrapped = requireApproval(deleteTool, {
      onApprove: () => new Promise(() => {}), // never resolves
      timeout: 30,
    });
    const res = await execute(wrapped, {});
    expect(res.ok).toBe(false);
    if (!res.ok && res.error.cause instanceof FlintError) {
      expect(res.error.cause.message).toContain('timed out');
    }
  });
});
