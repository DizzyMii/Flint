import Ajv from 'ajv';
import { tool } from 'flint';
import type { StandardSchemaV1, Tool } from 'flint';

const ajv = new Ajv({ allErrors: true });

function anyObjectSchema(): StandardSchemaV1<unknown, Record<string, unknown>> {
  return {
    '~standard': {
      version: 1,
      vendor: 'landlord',
      validate: (v) => {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          return { issues: [{ message: 'Expected an object' }] };
        }
        return { value: v as Record<string, unknown> };
      },
    },
  };
}

export type StructuredOutput = {
  tool: Tool;
  getValue: () => unknown;
};

/**
 * Build a forced `structured_output` tool for an `agent()` call. Object schemas
 * are presented as-is; non-object schemas are wrapped under a `result` key and
 * unwrapped on capture. The handler validates with ajv and returns a corrective
 * message on mismatch so the agent loop retries.
 */
export function makeStructuredOutput(schema: Record<string, unknown>): StructuredOutput {
  const wrapped = schema['type'] !== 'object';
  const jsonSchema: Record<string, unknown> = wrapped
    ? { type: 'object', properties: { result: schema }, required: ['result'] }
    : schema;

  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(jsonSchema);
  } catch {
    validate = ajv.compile({ type: 'object' });
  }

  let captured: unknown;
  let done = false;

  const t = tool({
    name: 'structured_output',
    description:
      'Return your final result as JSON matching the required schema. Call this exactly once.',
    input: anyObjectSchema(),
    jsonSchema,
    handler: (input: Record<string, unknown>) => {
      if (!validate(input)) {
        return `Output does not match the required schema: ${ajv.errorsText(validate.errors)}. Call structured_output again with corrected fields.`;
      }
      if (!done) {
        captured = wrapped ? (input as { result: unknown }).result : input;
        done = true;
      }
      return 'Accepted.';
    },
  }) as unknown as Tool;

  return { tool: t, getValue: () => captured };
}
