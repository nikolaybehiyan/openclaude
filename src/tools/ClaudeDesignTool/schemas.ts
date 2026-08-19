import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

export const claudeDesignInputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .string()
      .regex(/^[\w.-]{1,64}$/)
      .describe(
        'Claude Design action to perform. Call with "list" first to discover the available operations and their argument schemas.',
      ),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }),
)

export const claudeDesignOutputSchema = lazySchema(() =>
  z.object({
    operation: z.string(),
    content: z.array(z.record(z.string(), z.unknown())),
    isError: z.boolean().optional(),
  }),
)

export type ClaudeDesignInput = z.infer<ReturnType<typeof claudeDesignInputSchema>>
export type ClaudeDesignOutput = z.infer<ReturnType<typeof claudeDesignOutputSchema>>
