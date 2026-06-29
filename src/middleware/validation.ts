import { z } from 'zod';
import { config } from '../config';

export const SynologyRequestSchema = z.object({
  text: z.string().min(1).max(config.validation.maxTextLength),
  token: z.string().min(1),
  user_id: z.number().int().positive(),
  username: z.string().min(1).max(config.validation.maxUsernameLength).regex(/^[a-zA-Z0-9_-]+$/),
  post_id: z.number().int().positive().optional(),
  thread_id: z.number().int().positive().optional(),
  timestamp: z.number().int().positive().optional(),
});
