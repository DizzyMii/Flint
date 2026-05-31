// src/workflow/registry.ts
import type { Tool } from 'flint';
import { bashTool, fileReadTool, standardTools, webFetchTool } from '../tools/index.ts';
import { WorkflowError } from './errors.ts';

export type AgentType = {
  systemPrompt: string;
  tools?: (workDir: string) => Tool[];
  model?: string;
};

export type AgentTypeRegistry = {
  resolve(name: string): AgentType;
  has(name: string): boolean;
};

export const BUILT_IN_AGENT_TYPES: Record<string, AgentType> = {
  default: {
    systemPrompt:
      'You are a focused worker agent. Use your tools to accomplish the task. ' +
      'When a structured result is requested, return it by calling the structured_output tool.',
    tools: (workDir) => standardTools(workDir),
  },
  Explore: {
    systemPrompt:
      'You are a read-only exploration agent. Search broadly, read excerpts rather than whole ' +
      'files, and return conclusions — never modify anything. You have read and web tools only.',
    tools: (workDir) => [fileReadTool(workDir), webFetchTool(workDir)],
  },
  'code-reviewer': {
    systemPrompt:
      'You are a code reviewer. Read the relevant code and report concrete issues (bugs, security, ' +
      'quality) with file and line references. Return findings via structured_output when asked.',
    tools: (workDir) => [fileReadTool(workDir), bashTool(workDir)],
  },
};

export function createAgentRegistry(custom?: Record<string, AgentType>): AgentTypeRegistry {
  const merged: Record<string, AgentType> = { ...BUILT_IN_AGENT_TYPES, ...(custom ?? {}) };
  return {
    has: (name) => name in merged,
    resolve: (name) => {
      const t = merged[name];
      if (t === undefined) {
        throw new WorkflowError(
          `Unknown agentType '${name}'. Known: ${Object.keys(merged).join(', ')}`,
          'workflow.unknown_agent_type',
        );
      }
      return t;
    },
  };
}

export type WorkflowRegistry = {
  resolve(name: string): string | undefined;
};

export function createWorkflowRegistry(scripts: Record<string, string>): WorkflowRegistry {
  return { resolve: (name) => scripts[name] };
}
