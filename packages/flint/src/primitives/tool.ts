import type { StandardSchemaV1, Tool, ToolContext, ToolPermissions } from '../types.ts';

export type ToolSpec<Input, Output> = {
  name: string;
  description: string;
  input: StandardSchemaV1<unknown, Input>;
  handler: (input: Input, ctx: ToolContext) => Promise<Output> | Output;
  permissions?: ToolPermissions;
  timeout?: number;
  jsonSchema?: Record<string, unknown>;
  sequential?: boolean;
};

export function tool<Input, Output>(spec: ToolSpec<Input, Output>): Tool<Input, Output> {
  return {
    name: spec.name,
    description: spec.description,
    input: spec.input,
    handler: spec.handler,
    ...(spec.permissions !== undefined ? { permissions: spec.permissions } : {}),
    ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
    ...(spec.jsonSchema !== undefined ? { jsonSchema: spec.jsonSchema } : {}),
    ...(spec.sequential !== undefined ? { sequential: spec.sequential } : {}),
  };
}
