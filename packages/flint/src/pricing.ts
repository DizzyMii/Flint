import type { Usage } from './types.ts';

/**
 * Prices in US dollars per million tokens. `cacheRead` and `cacheWrite` default to 0.1x and 1.25x
 * of `input`. `longContext` switches the whole request to higher rates once the prompt (uncached +
 * cached + cache-write tokens) exceeds `threshold`.
 */
export type ModelPricing = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  longContext?: { threshold: number; input: number; output: number };
};

export type PriceTable = Record<string, ModelPricing>;

/** Exact match first, then the longest table key that prefixes the model id (handles dated or region-prefixed ids). */
export function lookupPricing(table: PriceTable, model: string): ModelPricing | undefined {
  const exact = table[model];
  if (exact) return exact;
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (model.includes(key) && (best === undefined || key.length > best.length)) best = key;
  }
  return best === undefined ? undefined : table[best];
}

function rates(p: ModelPricing, promptTokens: number) {
  const long = p.longContext !== undefined && promptTokens > p.longContext.threshold;
  const input = long && p.longContext ? p.longContext.input : p.input;
  const output = long && p.longContext ? p.longContext.output : p.output;
  const scale = input / p.input;
  return {
    input,
    output,
    cacheRead: (p.cacheRead ?? p.input * 0.1) * scale,
    cacheWrite: (p.cacheWrite ?? p.input * 1.25) * scale,
  };
}

export function costOf(usage: Usage, pricing: ModelPricing): number {
  const prompt = usage.input + (usage.cached ?? 0) + (usage.cacheWrite ?? 0);
  const r = rates(pricing, prompt);
  return (
    (usage.input * r.input +
      (usage.cached ?? 0) * r.cacheRead +
      (usage.cacheWrite ?? 0) * r.cacheWrite +
      usage.output * r.output) /
    1_000_000
  );
}

/** Worst-case dollar cost of a request: every prompt token uncached and the full output budget used. */
export function worstCaseCost(
  promptTokens: number,
  maxOutputTokens: number,
  pricing: ModelPricing,
): number {
  const r = rates(pricing, promptTokens);
  return (promptTokens * r.input + maxOutputTokens * r.output) / 1_000_000;
}

/** Output tokens affordable with `dollars` after paying for `promptTokens` of uncached input. */
export function affordableOutputTokens(
  dollars: number,
  promptTokens: number,
  pricing: ModelPricing,
): number {
  const r = rates(pricing, promptTokens);
  const left = dollars - (promptTokens * r.input) / 1_000_000;
  return left <= 0 ? 0 : Math.floor((left * 1_000_000) / r.output);
}
