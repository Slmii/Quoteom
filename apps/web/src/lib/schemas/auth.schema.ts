import z from 'zod';

export const SignInSchema = z.object({
	email: z.string().email('Please enter a valid email address')
});

export type SignInForm = z.infer<typeof SignInSchema>;

export const AcceptInviteSearchSchema = z.object({
	token: z.string().min(1)
});

export const VerifyRequestSearchSchema = z.object({
	email: z.string().optional()
});
