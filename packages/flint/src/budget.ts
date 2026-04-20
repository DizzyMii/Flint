import { BudgetExhausted } from './errors.ts';
import type { Usage } from './types.ts';

export type BudgetLimits = {
  maxSteps?: number;
  maxTokens?: number;
  maxDollars?: number;
};

export type BudgetRemaining = {
  steps?: number;
  tokens?: number;
  dollars?: number;
};

export type ConsumeInput = Partial<Usage> & { cost?: number };

export type Budget = {
  readonly limits: BudgetLimits;
  consume(x: ConsumeInput): void;
  assertNotExhausted(): void;
  remaining(): BudgetRemaining;
};

type ExhaustedField = {
  field: 'steps' | 'tokens' | 'dollars';
  limit: number;
  used: number;
};

export function budget(limits: BudgetLimits): Budget {
  if (
    limits.maxSteps === undefined &&
    limits.maxTokens === undefined &&
    limits.maxDollars === undefined
  ) {
    throw new TypeError('budget: at least one of maxSteps, maxTokens, or maxDollars must be set');
  }

  let stepsUsed = 0;
  let tokensUsed = 0;
  let dollarsUsed = 0;

  function checkExhaustedAfterConsume(): ExhaustedField | null {
    if (limits.maxSteps !== undefined && stepsUsed > limits.maxSteps) {
      return { field: 'steps', limit: limits.maxSteps, used: stepsUsed };
    }
    if (limits.maxTokens !== undefined && tokensUsed > limits.maxTokens) {
      return { field: 'tokens', limit: limits.maxTokens, used: tokensUsed };
    }
    if (limits.maxDollars !== undefined && dollarsUsed > limits.maxDollars) {
      return { field: 'dollars', limit: limits.maxDollars, used: dollarsUsed };
    }
    return null;
  }

  function checkExhaustedBefore(): ExhaustedField | null {
    if (limits.maxSteps !== undefined && stepsUsed >= limits.maxSteps) {
      return { field: 'steps', limit: limits.maxSteps, used: stepsUsed };
    }
    if (limits.maxTokens !== undefined && tokensUsed >= limits.maxTokens) {
      return { field: 'tokens', limit: limits.maxTokens, used: tokensUsed };
    }
    if (limits.maxDollars !== undefined && dollarsUsed >= limits.maxDollars) {
      return { field: 'dollars', limit: limits.maxDollars, used: dollarsUsed };
    }
    return null;
  }

  return {
    limits,
    consume(x) {
      stepsUsed += 1;
      tokensUsed += (x.input ?? 0) + (x.output ?? 0) + (x.cached ?? 0);
      dollarsUsed += x.cost ?? 0;
      const exhausted = checkExhaustedAfterConsume();
      if (exhausted) {
        throw new BudgetExhausted(
          `Budget exhausted: ${exhausted.field} used ${exhausted.used} >= limit ${exhausted.limit}`,
          { code: `budget.${exhausted.field}` },
        );
      }
    },
    assertNotExhausted() {
      const exhausted = checkExhaustedBefore();
      if (exhausted) {
        throw new BudgetExhausted(
          `Budget already exhausted: ${exhausted.field} used ${exhausted.used} >= limit ${exhausted.limit}`,
          { code: `budget.${exhausted.field}` },
        );
      }
    },
    remaining() {
      return {
        ...(limits.maxSteps !== undefined
          ? { steps: Math.max(0, limits.maxSteps - stepsUsed) }
          : {}),
        ...(limits.maxTokens !== undefined
          ? { tokens: Math.max(0, limits.maxTokens - tokensUsed) }
          : {}),
        ...(limits.maxDollars !== undefined
          ? { dollars: Math.max(0, limits.maxDollars - dollarsUsed) }
          : {}),
      };
    },
  };
}
