import { describe, expect, it } from 'vitest';
import { budget } from '../src/budget.ts';
import { BudgetExhausted } from '../src/errors.ts';

describe('budget', () => {
  it('throws TypeError when no limit field is set', () => {
    expect(() => budget({})).toThrow(TypeError);
  });

  it('accepts any single field', () => {
    expect(() => budget({ maxSteps: 1 })).not.toThrow();
    expect(() => budget({ maxTokens: 1 })).not.toThrow();
    expect(() => budget({ maxDollars: 0.01 })).not.toThrow();
  });

  it('exposes limits', () => {
    const b = budget({ maxSteps: 5, maxTokens: 100 });
    expect(b.limits.maxSteps).toBe(5);
    expect(b.limits.maxTokens).toBe(100);
    expect(b.limits.maxDollars).toBeUndefined();
  });

  it('consume increments steps by 1 per call', () => {
    const b = budget({ maxSteps: 10 });
    b.consume({ input: 1, output: 1 });
    b.consume({ input: 1, output: 1 });
    b.consume({ input: 1, output: 1 });
    expect(b.remaining().steps).toBe(7);
  });

  it('consume accumulates tokens (input + output + cached)', () => {
    const b = budget({ maxTokens: 1000 });
    b.consume({ input: 100, output: 50, cached: 20 });
    expect(b.remaining().tokens).toBe(1000 - 170);
  });

  it('consume accumulates cost', () => {
    const b = budget({ maxDollars: 1.0 });
    b.consume({ cost: 0.25 });
    b.consume({ cost: 0.3 });
    expect(b.remaining().dollars).toBeCloseTo(0.45);
  });

  it('throws BudgetExhausted when consume exceeds maxSteps', () => {
    const b = budget({ maxSteps: 2 });
    b.consume({});
    b.consume({});
    expect(() => b.consume({})).toThrow(BudgetExhausted);
  });

  it('BudgetExhausted has correct code for steps', () => {
    const b = budget({ maxSteps: 1 });
    b.consume({});
    try {
      b.consume({});
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExhausted);
      expect((e as BudgetExhausted).code).toBe('budget.steps');
    }
  });

  it('BudgetExhausted has correct code for tokens', () => {
    const b = budget({ maxTokens: 50 });
    try {
      b.consume({ input: 40, output: 20 });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as BudgetExhausted).code).toBe('budget.tokens');
    }
  });

  it('BudgetExhausted has correct code for dollars', () => {
    const b = budget({ maxDollars: 0.5 });
    try {
      b.consume({ cost: 0.6 });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as BudgetExhausted).code).toBe('budget.dollars');
    }
  });

  it('assertNotExhausted throws when already over', () => {
    const b = budget({ maxSteps: 1 });
    b.consume({});
    // already at exhaustion boundary
    expect(() => b.assertNotExhausted()).toThrow(BudgetExhausted);
  });

  it('assertNotExhausted passes when under limits', () => {
    const b = budget({ maxSteps: 5 });
    b.consume({});
    expect(() => b.assertNotExhausted()).not.toThrow();
  });

  it('remaining returns undefined for unset fields', () => {
    const b = budget({ maxSteps: 5 });
    const r = b.remaining();
    expect(r.steps).toBe(5);
    expect(r.tokens).toBeUndefined();
    expect(r.dollars).toBeUndefined();
  });

  it('remaining returns 0 when exactly at limit, not negative', () => {
    const b = budget({ maxSteps: 2 });
    b.consume({});
    b.consume({});
    expect(b.remaining().steps).toBe(0);
  });

  it('remaining returns 0 when over limit (not negative)', () => {
    const b = budget({ maxTokens: 10 });
    try {
      b.consume({ input: 100 });
    } catch {
      // expected
    }
    expect(b.remaining().tokens).toBe(0);
  });

  it('steps check takes priority over tokens when both exceeded', () => {
    const b = budget({ maxSteps: 0, maxTokens: 10 });
    // First consume: steps goes to 1, tokens to 1000 — both exceeded
    try {
      b.consume({ input: 500, output: 500 });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as BudgetExhausted).code).toBe('budget.steps');
    }
  });
});
