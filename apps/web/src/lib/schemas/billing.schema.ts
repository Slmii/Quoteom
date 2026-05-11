import { z } from 'zod';

export const BillingSearchSchema = z.object({
	session_id: z.string().optional()
});
