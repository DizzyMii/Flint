import type { NormalizedResponse } from 'flint';
import { execute } from 'flint';
import { scriptedAdapter } from 'flint/testing';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_TOOL_GUIDE, workflowTool } from '../../src/workflow/tool.ts';

function textResponse(content: string): NormalizedResponse {
  return {
    message: { role: 'assistant', content },
    usage: { input: 10, output: 5 },
    stopReason: 'end',
  };
}

describe('workflowTool', () => {
  it('runs a script supplied as tool input and returns runId + result', async () => {
    const adapter = scriptedAdapter([textResponse('inner-result')]);
    const tool = workflowTool({ adapter, models: { default: 'm' } });
    const res = await execute(tool, {
      script: `export const meta = { name: 'x', description: 'y' }\nreturn await agent('go')`,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const parsed = JSON.parse(res.value as string);
      expect(parsed.result).toBe('inner-result');
      expect(typeof parsed.runId).toBe('string');
    }
  });

  it('errors clearly when neither script nor name is provided', async () => {
    const tool = workflowTool({ adapter: scriptedAdapter([]), models: { default: 'm' } });
    const res = await execute(tool, {});
    expect(res.ok).toBe(true);
    expect(String(res.ok ? res.value : '')).toMatch(/provide either/i);
  });
});

describe('WORKFLOW_TOOL_GUIDE', () => {
  it('documents the core hooks', () => {
    expect(WORKFLOW_TOOL_GUIDE).toMatch(/pipeline/);
    expect(WORKFLOW_TOOL_GUIDE).toMatch(/parallel/);
    expect(WORKFLOW_TOOL_GUIDE).toMatch(/schema/);
  });
});
