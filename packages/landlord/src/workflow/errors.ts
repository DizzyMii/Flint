// src/workflow/errors.ts
import { FlintError } from 'flint/errors';

export class WorkflowError extends FlintError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, { code, ...(cause !== undefined ? { cause } : {}) });
    this.name = 'WorkflowError';
  }
}

export class AgentCapError extends WorkflowError {
  constructor(message: string) {
    super(message, 'workflow.agent_cap');
    this.name = 'AgentCapError';
  }
}

export class MetaError extends WorkflowError {
  constructor(message: string) {
    super(message, 'workflow.meta');
    this.name = 'MetaError';
  }
}
