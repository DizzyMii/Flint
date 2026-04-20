import { FlintError } from '../errors.ts';
import type { Tool } from '../types.ts';

export type ApprovalContext<Input> = {
  tool: Tool<Input>;
  input: Input;
};

export type ApprovalResult =
  | boolean
  | { approved: boolean; reason?: string };

export type RequireApprovalOptions<Input> = {
  onApprove: (ctx: ApprovalContext<Input>) => Promise<ApprovalResult>;
  timeout?: number;
};

export function requireApproval<Input, Output>(
  t: Tool<Input, Output>,
  opts: RequireApprovalOptions<Input>,
): Tool<Input, Output> {
  const timeoutMs = opts.timeout ?? 5 * 60 * 1000;

  const wrappedHandler = async (input: Input): Promise<Output> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const approvalPromise = opts.onApprove({ tool: t, input });
    const timeoutPromise = new Promise<ApprovalResult>((resolve) => {
      timeoutId = setTimeout(
        () => resolve({ approved: false, reason: 'Approval timed out' }),
        timeoutMs,
      );
    });

    try {
      const raw = await Promise.race<ApprovalResult>([approvalPromise, timeoutPromise]);
      const result: { approved: boolean; reason?: string } =
        typeof raw === 'boolean' ? { approved: raw } : raw;

      if (!result.approved) {
        throw new FlintError(
          `Tool "${t.name}" approval denied${result.reason ? `: ${result.reason}` : ''}`,
          { code: 'tool.approval_denied' },
        );
      }

      return await t.handler(input);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  };

  return {
    ...t,
    handler: wrappedHandler,
    permissions: {
      ...(t.permissions ?? {}),
      requireApproval: true,
    },
  };
}
