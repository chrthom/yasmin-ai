import { z } from 'zod';
import { config } from '../config';

/**
 * Runtime validation schema every incoming Synology Chat webhook body (bot, slash, group) must
 * pass before any controller logic runs. Field limits come from config.validation.
 */
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
