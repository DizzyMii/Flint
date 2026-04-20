import { ParseError, TimeoutError, ToolError } from '../errors.ts';
import type { Result, Tool } from '../types.ts';
import { validate } from './validate.ts';

export async function execute<Input, Output>(
  t: Tool<Input, Output>,
  rawInput: unknown,
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

  const runHandler = async (): Promise<Output> => t.handler(parsed.value);

  if (t.timeout === undefined) {
    try {
      const output = await runHandler();
      return { ok: true, value: output };
    } catch (e) {
      return {
        ok: false,
        error: new ToolError(`Tool "${t.name}" handler threw`, {
          code: 'tool.handler_threw',
          cause: e,
        }),
      };
    }
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race<Output>([
      runHandler(),
      new Promise<Output>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new TimeoutError(`Tool "${t.name}" timed out after ${t.timeout}ms`, {
              code: 'tool.timeout',
            }),
          );
        }, t.timeout);
      }),
    ]);
    return { ok: true, value: output };
  } catch (e) {
    if (e instanceof TimeoutError) {
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
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
