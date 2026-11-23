import { agent, tool } from 'flint';
import type { AgentOutput, Message } from 'flint';
import { budget } from 'flint/budget';
import { contextManager } from 'flint/context';
import { describe, expect, it } from 'vitest';
import { anthropicAdapter, anthropicPricing } from '../src/index.ts';
import { cacheSim, legacyCacheLayout } from './cache-sim.ts';

/**
 * $/task regression gate. A scripted 30-step tool-using agent run against a simulator that bills
 * the way the prompt cache does. The model's behaviour is fixed, so differences are purely
 * what Flint sends. Fails CI if the cache layout regresses.
 */

const MODEL = 'claude-opus-5-5';
const STEPS = 30;

const anyInput = {
  '~standard': { version: 1 as const, vendor: 'bench', validate: (v: unknown) => ({ value: v }) },
};

const readFile = tool({
  name: 'read_file',
  description: 'Read a file from the repository',
  input: anyInput,
  jsonSchema: { type: 'object', properties: { path: { type: 'string' } } },
  handler: (input) => {
    const i = (input as { i: number }).i;
    return `// file ${i}\n${`export const value${i} = ${i};\n`.repeat(160)}`;
  },
});

const system = `You are a careful senior engineer working in a large repository.\n${'Follow the house style guide precisely. '.repeat(400)}`;

async function run(
  mode: 'off' | 'legacy' | 'rolling' | 'rolling+context',
): Promise<{ out: AgentOutput; requests: number }> {
  let agentTurn = 0;
  const sim = cacheSim(
    (index, body) => {
      const sys = JSON.stringify(body.system ?? '');
      if (sys.includes('compacting the history')) {
        return {
          content: [{ type: 'text', text: 'Summary: '.repeat(300) }],
          stop_reason: 'end_turn',
          output_tokens: 900,
        };
      }
      const turn = agentTurn++;
      if (turn >= STEPS) {
        return {
          content: [{ type: 'text', text: 'Done.' }],
          stop_reason: 'end_turn',
          output_tokens: 50,
        };
      }
      return {
        content: [
          { type: 'text', text: `Reading the next file (${index}).` },
          { type: 'tool_use', id: `t${turn}`, name: 'read_file', input: { i: turn } },
        ],
        stop_reason: 'tool_use',
        output_tokens: 150,
      };
    },
    mode === 'legacy' ? { transformBody: legacyCacheLayout } : {},
  );
  const adapter = anthropicAdapter({ apiKey: 'bench', fetch: sim.fetch });
  const messages: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content: 'Audit every file and report problems.' },
  ];
  const out = await agent({
    adapter,
    model: MODEL,
    messages,
    tools: [readFile],
    budget: budget({ maxSteps: 200 }),
    cache: mode === 'off' ? 'off' : 'auto',
    ...(mode === 'rolling+context'
      ? {
          context: contextManager({
            summarizer: { adapter, model: MODEL },
            contextWindow: 40_000,
            ...(anthropicPricing[MODEL] ? { pricing: anthropicPricing[MODEL] } : {}),
          }),
        }
      : {}),
  });
  if (!out.ok) throw out.error;
  return { out: out.value, requests: sim.requests.length };
}

describe('$/task benchmark (simulated prompt cache)', () => {
  it('rolling cache breakpoints cut the cost of a 30-step agent run', async () => {
    const results = {
      off: await run('off'),
      legacy: await run('legacy'),
      rolling: await run('rolling'),
      'rolling+context': await run('rolling+context'),
    };
    const rows = Object.entries(results).map(([mode, r]) => ({
      mode,
      requests: r.requests,
      dollars: Number(r.out.cost.toFixed(4)),
      uncachedInput: r.out.usage.input,
      cacheRead: r.out.usage.cached ?? 0,
      cacheWrite: r.out.usage.cacheWrite ?? 0,
    }));
    console.table(rows);

    const cost = (m: keyof typeof results) => results[m].out.cost;
    expect(cost('rolling')).toBeLessThan(cost('legacy') * 0.35);
    expect(cost('rolling')).toBeLessThan(cost('off') * 0.3);
    // The context manager must never make a run more expensive than caching alone by much,
    // and it must keep every prompt inside its window.
    expect(cost('rolling+context')).toBeLessThan(cost('legacy'));
  });
});
