import { agent, tool } from 'flint';
import { budget as makeBudget } from 'flint/budget';
import type { Budget } from 'flint/budget';
import type { ProviderAdapter, Result, StandardSchemaV1, Tool } from 'flint';
import type { Checkpoint, Contract } from './contract.ts';
import { validateCheckpoint } from './validate.ts';

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

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildSystemPrompt(
  contract: Contract,
  sharedArtifacts: Record<string, unknown> | undefined,
  retryContext: string | undefined,
): string {
  const parts: string[] = [
    `You are a ${contract.role}.`,
    `Objective: ${contract.objective}`,
  ];

  if (contract.checkpoints.length > 0) {
    const lines = contract.checkpoints.map(
      cp => `- ${cp.name}: call \`emit_checkpoint__${sanitizeName(cp.name)}\` when ${cp.description}`,
    );
    parts.push(`Checkpoints — call each tool when you reach the milestone:\n${lines.join('\n')}`);
  }

  parts.push(
    'You also have filesystem and shell tools sandboxed to your working directory. ' +
    'Checkpoint tools are how you declare structured results back to the orchestrator.',
  );

  if (sharedArtifacts !== undefined && Object.keys(sharedArtifacts).length > 0) {
    parts.push(`Context from dependencies:\n${JSON.stringify(sharedArtifacts, null, 2)}`);
  }

  if (retryContext !== undefined) {
    parts.push(`Previous attempt failed. Retry context:\n${retryContext}`);
  }

  return parts.join('\n\n');
}

function filterTools(userTools: Tool[], contract: Contract): Tool[] {
  if (contract.toolsAllowed !== undefined) {
    return userTools.filter(t => contract.toolsAllowed!.includes(t.name));
  }
  if (contract.toolsDenied !== undefined) {
    return userTools.filter(t => !contract.toolsDenied!.includes(t.name));
  }
  return userTools;
}

export async function runTenant(
  contract: Contract,
  userTools: Tool[],
  ctx: { adapter: ProviderAdapter; model: string; budget?: Budget; workDir: string },
  retryContext?: string,
  sharedArtifacts?: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const artifacts: Record<string, unknown> = {};

  const checkpointTools: Tool[] = contract.checkpoints.map((cp: Checkpoint) => {
    const schema = (cp.schema['type'] === 'object')
      ? cp.schema
      : { type: 'object', properties: { result: cp.schema }, required: ['result'] };

    return tool({
      name: `emit_checkpoint__${sanitizeName(cp.name)}`,
      description: `Declare checkpoint '${cp.name}' reached: ${cp.description}.`,
      input: anyObjectSchema(),
      jsonSchema: schema as Record<string, unknown>,
      handler: async (input) => {
        const verdict = await validateCheckpoint(input, cp, ctx);
        if (verdict.ok && verdict.value.passed) {
          artifacts[cp.name] = input;
          return { ok: true, message: `Checkpoint '${cp.name}' passed.` };
        }
        const explanation = verdict.ok ? verdict.value.explanation : verdict.error.message;
        return { ok: false, message: `Checkpoint '${cp.name}' failed: ${explanation}. Revise and retry.` };
      },
    }) as unknown as Tool;
  });

  const allTools = [...checkpointTools, ...filterTools(userTools, contract)];
  const systemPrompt = buildSystemPrompt(contract, sharedArtifacts, retryContext);
  const tenantBudget = ctx.budget ?? makeBudget({ maxSteps: 100 });

  const agentResult = await agent({
    adapter: ctx.adapter,
    model: ctx.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: contract.subPrompt },
    ],
    tools: allTools,
    budget: tenantBudget,
  });

  if (!agentResult.ok) return agentResult;

  const requiredNames = new Set(contract.checkpoints.map((cp: Checkpoint) => cp.name));
  const passedNames = new Set(Object.keys(artifacts));
  const missing = [...requiredNames].filter(n => !passedNames.has(n));

  if (missing.length > 0) {
    return {
      ok: false,
      error: new Error(`Tenant finished without passing checkpoints: ${missing.join(', ')}`),
    };
  }

  return { ok: true, value: artifacts };
}
