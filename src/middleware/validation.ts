import { z } from 'zod';
import { config } from '../config';

export const SynologyRequestSchema = z.object({
  text: z.string().min(1).max(config.validation.maxTextLength),
  token: z.string().min(1).optional(),
  user_id: z.coerce.number().int().nonnegative(),
  username: z
    .string()
    .min(1)
    .max(config.validation.maxUsernameLength)
    .regex(/^[a-zA-Z0-9_-]+$/),
  post_id: z.coerce.number().int().nonnegative().optional(),
  thread_id: z.coerce.number().int().nonnegative().optional(),
  timestamp: z.coerce.number().int().positive().optional()
});
