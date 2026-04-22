import Ajv from 'ajv';
import { call } from 'flint';
import type { ProviderAdapter, Result } from 'flint';
import type { Budget } from 'flint/budget';
import type { Checkpoint } from './contract.ts';

const ajv = new Ajv({ allErrors: true });

export type ValidationVerdict = { passed: boolean; explanation: string };

const JUDGE_SYSTEM =
  'You are a checkpoint validator. Given a checkpoint definition and the output produced by an agent, ' +
  'judge whether the output genuinely satisfies the checkpoint. ' +
  'Respond ONLY with valid JSON: {"passed": true|false, "explanation": "one sentence reason"}.';

export async function validateCheckpoint(
  output: Record<string, unknown>,
  checkpoint: Checkpoint,
  ctx: { adapter: ProviderAdapter; model: string; budget?: Budget },
): Promise<Result<ValidationVerdict>> {
  // Tier 1: JSON Schema validation
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(checkpoint.schema);
  } catch {
    validate = ajv.compile({ type: 'object' });
  }

  const tier1Pass = validate(output);
  if (!tier1Pass) {
    const explanation = ajv.errorsText(validate.errors) ?? 'JSON Schema validation failed';
    return { ok: true, value: { passed: false, explanation } };
  }

  // Tier 2: LLM semantic judge
  const judgeResult = await call({
    adapter: ctx.adapter,
    model: ctx.model,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          checkpoint: { name: checkpoint.name, description: checkpoint.description },
          output,
        }),
      },
    ],
    ...(ctx.budget !== undefined ? { budget: ctx.budget } : {}),
  });

  if (!judgeResult.ok) return judgeResult;

  let verdict: { passed?: unknown; explanation?: unknown };
  try {
    verdict = JSON.parse(judgeResult.value.message.content) as typeof verdict;
  } catch {
    return { ok: false, error: new Error('Judge response was not valid JSON') };
  }

  if (typeof verdict.passed !== 'boolean' || typeof verdict.explanation !== 'string') {
    return { ok: false, error: new Error('Judge response missing required fields') };
  }

  return { ok: true, value: { passed: verdict.passed, explanation: verdict.explanation } };
}
