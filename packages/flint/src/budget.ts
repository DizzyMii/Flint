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

export type BudgetSpent = {
  steps: number;
  tokens: number;
  dollars: number;
};

/** `steps` defaults to 1; pass 0 for spend that should not count as an agent step (e.g. a summarizer call). */
export type ConsumeInput = Partial<Usage> & { cost?: number; steps?: number };

/** A hold on budget for an in-flight request, so concurrent callers cannot jointly overspend. */
export type Reservation = { release(): void };

export type Budget = {
  readonly limits: BudgetLimits;
  consume(x: ConsumeInput): void;
  assertNotExhausted(): void;
  /** Remaining after spend and outstanding reservations. */
  remaining(): BudgetRemaining;
  spent?(): BudgetSpent;
  reserve?(x: { tokens?: number; dollars?: number }): Reservation;
  /** A sub-budget: spend counts against both, and the child is exhausted when either is. */
  child?(limits: BudgetLimits): Budget;
};

type ExhaustedField = {
  field: 'steps' | 'tokens' | 'dollars';
  limit: number;
  used: number;
};

function usageTokens(x: Partial<Usage>): number {
  return (x.input ?? 0) + (x.output ?? 0) + (x.cached ?? 0) + (x.cacheWrite ?? 0);
}

export function budget(limits: BudgetLimits, parent?: Budget): Budget {
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
  let tokensReserved = 0;
  let dollarsReserved = 0;

  function check(strict: boolean): ExhaustedField | null {
    const over = (used: number, limit: number) => (strict ? used >= limit : used > limit);
    if (limits.maxSteps !== undefined && over(stepsUsed, limits.maxSteps)) {
      return { field: 'steps', limit: limits.maxSteps, used: stepsUsed };
    }
    if (limits.maxTokens !== undefined && over(tokensUsed, limits.maxTokens)) {
      return { field: 'tokens', limit: limits.maxTokens, used: tokensUsed };
    }
    if (limits.maxDollars !== undefined && over(dollarsUsed, limits.maxDollars)) {
      return { field: 'dollars', limit: limits.maxDollars, used: dollarsUsed };
    }
    return null;
  }

  function minDefined(a: number | undefined, b: number | undefined): number | undefined {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.min(a, b);
  }

  const self: Budget = {
    limits,
    consume(x) {
      stepsUsed += x.steps ?? 1;
      tokensUsed += usageTokens(x);
      dollarsUsed += x.cost ?? 0;
      parent?.consume(x);
      const exhausted = check(false);
      if (exhausted) {
        throw new BudgetExhausted(
          `Budget exhausted: ${exhausted.field} used ${exhausted.used} >= limit ${exhausted.limit}`,
          { code: `budget.${exhausted.field}` },
        );
      }
    },
    assertNotExhausted() {
      parent?.assertNotExhausted();
      const exhausted = check(true);
      if (exhausted) {
        throw new BudgetExhausted(
          `Budget already exhausted: ${exhausted.field} used ${exhausted.used} >= limit ${exhausted.limit}`,
          { code: `budget.${exhausted.field}` },
        );
      }
    },
    remaining() {
      const own: BudgetRemaining = {
        ...(limits.maxSteps !== undefined
          ? { steps: Math.max(0, limits.maxSteps - stepsUsed) }
          : {}),
        ...(limits.maxTokens !== undefined
          ? { tokens: Math.max(0, limits.maxTokens - tokensUsed - tokensReserved) }
          : {}),
        ...(limits.maxDollars !== undefined
          ? { dollars: Math.max(0, limits.maxDollars - dollarsUsed - dollarsReserved) }
          : {}),
      };
      if (!parent) return own;
      const p = parent.remaining();
      const steps = minDefined(own.steps, p.steps);
      const tokens = minDefined(own.tokens, p.tokens);
      const dollars = minDefined(own.dollars, p.dollars);
      return {
        ...(steps !== undefined ? { steps } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
        ...(dollars !== undefined ? { dollars } : {}),
      };
    },
    spent() {
      return { steps: stepsUsed, tokens: tokensUsed, dollars: dollarsUsed };
    },
    reserve(x) {
      const tokens = x.tokens ?? 0;
      const dollars = x.dollars ?? 0;
      tokensReserved += tokens;
      dollarsReserved += dollars;
      const parentHold = parent?.reserve?.(x);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          tokensReserved -= tokens;
          dollarsReserved -= dollars;
          parentHold?.release();
        },
      };
    },
    child(childLimits) {
      return budget(childLimits, self);
    },
  };
  return self;
}
