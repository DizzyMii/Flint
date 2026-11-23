import { ParseError, TimeoutError, ToolError } from '../errors.ts';
import type { Result, Tool } from '../types.ts';
import { validate } from './validate.ts';

export type ExecuteOptions = {
  signal?: AbortSignal;
  toolCallId?: string;
  step?: number;
};

export async function execute<Input, Output>(
  t: Tool<Input, Output>,
  rawInput: unknown,
  opts: ExecuteOptions = {},
): Promise<Result<Output>> {
  const parsed = await validate(rawInput, t.input);
  if (!parsed.ok) {
    return {
      ok: false,
      error: new ParseError(`Tool "${t.name}" input validation failed`, {
        code: 'parse.tool_input',
        cause: parsed.error,
      }),
    };
  }

  // The handler sees one signal that fires on timeout or when the caller aborts, so it can stop work
  // instead of running on after its result has been discarded.
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) controller.abort(opts.signal.reason);
  else opts.signal?.addEventListener('abort', onParentAbort, { once: true });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        const reason: unknown = controller.signal.reason;
        reject(
          reason instanceof Error
            ? reason
            : new ToolError(`Tool "${t.name}" aborted`, { code: 'tool.aborted', cause: reason }),
        );
      },
      { once: true },
    );
  });
  aborted.catch(() => {});
  if (t.timeout !== undefined) {
    timeoutId = setTimeout(() => {
      controller.abort(
        new TimeoutError(`Tool "${t.name}" timed out after ${t.timeout}ms`, {
          code: 'tool.timeout',
        }),
      );
    }, t.timeout);
  }

  try {
    const output = await Promise.race([
      Promise.resolve().then(() =>
        t.handler(parsed.value, {
          signal: controller.signal,
          ...(opts.toolCallId !== undefined ? { toolCallId: opts.toolCallId } : {}),
          ...(opts.step !== undefined ? { step: opts.step } : {}),
        }),
      ),
      aborted,
    ]);
    return { ok: true, value: output };
  } catch (e) {
    if (e instanceof TimeoutError || (e instanceof ToolError && e.code === 'tool.aborted')) {
      return { ok: false, error: e };
    }
    return {
      ok: false,
      error: new ToolError(`Tool "${t.name}" handler threw`, {
        code: 'tool.handler_threw',
        cause: e,
      }),
    };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    opts.signal?.removeEventListener('abort', onParentAbort);
  }
}
