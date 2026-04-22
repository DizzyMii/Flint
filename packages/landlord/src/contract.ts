import { z } from 'zod';

export const CheckpointSchema = z.object({
  name: z.string(),
  description: z.string(),
  schema: z.record(z.unknown()),
});

export const ContractSchema = z.object({
  tenantId: z.string().default(() => crypto.randomUUID().slice(0, 8)),
  role: z.string(),
  objective: z.string(),
  subPrompt: z.string(),
  checkpoints: z.array(CheckpointSchema),
  outputSchema: z.record(z.unknown()),
  toolsAllowed: z.array(z.string()).optional(),
  toolsDenied: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).default([]),
  maxRetries: z.number().default(3),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type Contract = z.infer<typeof ContractSchema>;
