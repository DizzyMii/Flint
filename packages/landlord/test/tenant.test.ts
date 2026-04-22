import { describe, expect, it } from 'vitest';
import { runTenant } from '../src/tenant.ts';
import { tool } from 'flint';
import { budget } from 'flint/budget';
import { mockAdapter } from 'flint/testing';
import type { NormalizedResponse } from 'flint';
import type { Contract } from '../src/contract.ts';

function anySchema() {
  return { '~standard': { version: 1 as const, vendor: 'test', validate: (v: unknown) => ({ value: v }) } };
}

function textResponse(content: string): NormalizedResponse {
  return { message: { role: 'assistant', content }, usage: { input: 10, output: 5 }, stopReason: 'end' };
}

function toolCallResponse(name: string, args: unknown): NormalizedResponse {
  return {
    message: { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name, arguments: args }] },
    usage: { input: 20, output: 10 },
    stopReason: 'tool_call',
  };
}

function judgePassResponse(): NormalizedResponse {
  return {
    message: { role: 'assistant', content: JSON.stringify({ passed: true, explanation: 'Good' }) },
    usage: { input: 10, output: 5 },
    stopReason: 'end',
  };
}

const simpleContract: Contract = {
  tenantId: 'abc12345',
  role: 'coder',
  objective: 'Write a function',
  subPrompt: 'Write a TypeScript add function',
  checkpoints: [{
    name: 'code_written',
    description: 'Code has been written',
    schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  }],
  outputSchema: {},
  dependsOn: [],
  maxRetries: 3,
};

const emptyCheckpointContract: Contract = { ...simpleContract, checkpoints: [] };

describe('runTenant', () => {
  it('succeeds when agent calls all checkpoint tools and they pass', async () => {
    const adapter = mockAdapter({
      onCall: (_req, i) => {
        // First call: agent decides to call checkpoint tool
        if (i === 0) return toolCallResponse('emit_checkpoint__code_written', { code: 'const add = (a, b) => a + b;' });
        // Second call: validate (judge) — passes
        if (i === 1) return judgePassResponse();
        // Third call: agent finishes after checkpoint
        return textResponse('Done');
      },
    });

    const result = await runTenant(
      simpleContract,
      [],
      { adapter, model: 'test', budget: budget({ maxSteps: 20 }), workDir: '/tmp/test' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value['code_written']).toMatchObject({ code: expect.any(String) });
    }
  });

  it('returns error when agent finishes without calling all checkpoints', async () => {
    const adapter = mockAdapter({
      onCall: () => textResponse('I am done (but did not call checkpoint)'),
    });

    const result = await runTenant(
      simpleContract,
      [],
      { adapter, model: 'test', budget: budget({ maxSteps: 20 }), workDir: '/tmp/test' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/code_written/);
    }
  });

  it('succeeds immediately for zero-checkpoint contract', async () => {
    const adapter = mockAdapter({ onCall: () => textResponse('Done') });

    const result = await runTenant(
      emptyCheckpointContract,
      [],
      { adapter, model: 'test', budget: budget({ maxSteps: 5 }), workDir: '/tmp/test' },
    );

    expect(result.ok).toBe(true);
  });

  it('passes user tools to agent alongside checkpoint tools', async () => {
    let receivedToolNames: string[] = [];
    const adapter = mockAdapter({
      onCall: (req) => {
        receivedToolNames = (req.tools ?? []).map(t => t.name);
        return textResponse('Done');
      },
    });

    const userTool = tool({ name: 'my_tool', description: 'x', input: anySchema(), handler: () => 'ok' });

    await runTenant(
      emptyCheckpointContract,
      [userTool],
      { adapter, model: 'test', budget: budget({ maxSteps: 5 }), workDir: '/tmp/test' },
    );

    expect(receivedToolNames).toContain('my_tool');
  });

  it('respects toolsAllowed filter', async () => {
    let receivedToolNames: string[] = [];
    const adapter = mockAdapter({
      onCall: (req) => {
        receivedToolNames = (req.tools ?? []).map(t => t.name);
        return textResponse('Done');
      },
    });

    const tool1 = tool({ name: 'allowed_tool', description: 'x', input: anySchema(), handler: () => 'ok' });
    const tool2 = tool({ name: 'denied_tool', description: 'x', input: anySchema(), handler: () => 'ok' });
    const contractWithFilter: Contract = { ...emptyCheckpointContract, toolsAllowed: ['allowed_tool'] };

    await runTenant(
      contractWithFilter,
      [tool1, tool2],
      { adapter, model: 'test', budget: budget({ maxSteps: 5 }), workDir: '/tmp/test' },
    );

    expect(receivedToolNames).toContain('allowed_tool');
    expect(receivedToolNames).not.toContain('denied_tool');
  });
});
