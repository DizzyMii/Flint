import { call, tool } from 'flint';
import type { ProviderAdapter, Result, StandardSchemaV1 } from 'flint';
import type { Budget } from 'flint/budget';
import { ContractSchema } from './contract.ts';
import type { Contract } from './contract.ts';

const DECOMPOSE_SYSTEM =
  'You are the Landlord, an agentic orchestrator. Decompose the user request into independent ' +
  'sub-tasks for isolated worker agents (tenants) that can run in parallel where possible. ' +
  'For each tenant return: role (short unique name), objective, subPrompt (what the tenant receives), ' +
  'checkpoints (list of {name, description, schema} with lenient JSON Schemas), outputSchema, ' +
  'and dependsOn (roles whose outputs this tenant needs). Keep the plan minimal. ' +
  'Call the emit_plan tool with the contracts array.';

const EMIT_PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    contracts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          objective: { type: 'string' },
          subPrompt: { type: 'string' },
          checkpoints: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                schema: { type: 'object' },
              },
              required: ['name', 'description', 'schema'],
            },
          },
          outputSchema: { type: 'object' },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['role', 'objective', 'subPrompt', 'checkpoints', 'outputSchema'],
      },
    },
  },
  required: ['contracts'],
};

function anySchema(): StandardSchemaV1<unknown, unknown> {
  return {
    '~standard': { version: 1, vendor: 'landlord', validate: (v) => ({ value: v }) },
  };
}

const emitPlanTool = tool({
  name: 'emit_plan',
  description: 'Return the decomposed plan as a list of Contract objects.',
  input: anySchema(),
  handler: (v) => v,
  jsonSchema: EMIT_PLAN_JSON_SCHEMA,
});

export async function decompose(
  prompt: string,
  ctx: { adapter: ProviderAdapter; model: string; budget?: Budget },
): Promise<Result<Contract[]>> {
  const result = await call({
    adapter: ctx.adapter,
    model: ctx.model,
    messages: [
      { role: 'system', content: DECOMPOSE_SYSTEM },
      { role: 'user', content: prompt },
    ],
    tools: [emitPlanTool],
    ...(ctx.budget !== undefined ? { budget: ctx.budget } : {}),
  });

  if (!result.ok) return result;

  const planCall = result.value.message.toolCalls?.find(tc => tc.name === 'emit_plan');
  if (planCall === undefined) {
    return { ok: false, error: new Error('LLM did not call emit_plan — no plan produced') };
  }

  const raw = planCall.arguments as { contracts?: unknown[] };
  const rawContracts = raw.contracts ?? [];

  const contracts: Contract[] = [];
  for (const item of rawContracts) {
    const parsed = ContractSchema.safeParse(item);
    if (parsed.success) contracts.push(parsed.data);
  }

  return { ok: true, value: contracts };
}
