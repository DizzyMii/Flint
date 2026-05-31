// src/workflow/script.ts
import { parseMeta } from './meta.ts';
import { sandboxBindings } from './sandbox.ts';
import type { WorkflowContext, WorkflowModule } from './types.ts';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

export function stripModuleSyntax(source: string): string {
  let body = source.replace(/export\s+const\s+meta\s*=/, 'const __meta__ =');
  body = body.replace(/^\s*import\s.*$/gm, '');
  body = body.replace(/export\s+default\s+/g, 'return ');
  body = body.replace(/export\s+(const|let|var|function|class)\s/g, '$1 ');
  return body;
}

export function compileScript(source: string): WorkflowModule {
  const meta = parseMeta(source);
  const body = stripModuleSyntax(source);
  const sandbox = sandboxBindings();
  const sandboxNames = Object.keys(sandbox);
  const sandboxValues = sandboxNames.map((n) => sandbox[n]);
  const hookNames = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow'];
  const fn = new AsyncFunction(...hookNames, ...sandboxNames, body);
  const run = (wf: WorkflowContext): Promise<unknown> =>
    fn(
      wf.agent,
      wf.parallel,
      wf.pipeline,
      wf.phase,
      wf.log,
      wf.args,
      wf.budget,
      wf.workflow,
      ...sandboxValues,
    );
  return { meta, run };
}
