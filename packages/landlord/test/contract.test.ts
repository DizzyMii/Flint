import { describe, expect, it } from 'vitest';
import { ContractSchema, CheckpointSchema } from '../src/contract.ts';

describe('CheckpointSchema', () => {
  it('parses valid checkpoint', () => {
    const result = CheckpointSchema.safeParse({
      name: 'schema_ready',
      description: 'DB schema has been generated',
      schema: { type: 'object', properties: { tables: { type: 'array' } }, required: ['tables'] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('schema_ready');
    }
  });

  it('rejects missing name', () => {
    const result = CheckpointSchema.safeParse({ description: 'x', schema: {} });
    expect(result.success).toBe(false);
  });
});

describe('ContractSchema', () => {
  it('parses minimal contract and fills defaults', () => {
    const result = ContractSchema.safeParse({
      role: 'backend_engineer',
      objective: 'Build REST API',
      subPrompt: 'Create a Node.js REST API with Express',
      checkpoints: [],
      outputSchema: { type: 'object' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependsOn).toEqual([]);
      expect(result.data.maxRetries).toBe(3);
      expect(result.data.tenantId).toHaveLength(8);
    }
  });

  it('parses contract with dependsOn', () => {
    const result = ContractSchema.safeParse({
      role: 'test_engineer',
      objective: 'Write tests',
      subPrompt: 'Write tests for the API',
      checkpoints: [],
      outputSchema: {},
      dependsOn: ['backend_engineer'],
      maxRetries: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependsOn).toEqual(['backend_engineer']);
      expect(result.data.maxRetries).toBe(5);
    }
  });

  it('rejects missing role', () => {
    const result = ContractSchema.safeParse({
      objective: 'x',
      subPrompt: 'x',
      checkpoints: [],
      outputSchema: {},
    });
    expect(result.success).toBe(false);
  });
});
