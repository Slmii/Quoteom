import { z } from 'zod';

/**
 * Single source of truth for every env var the API reads.
 *
 * - Validated at boot via `ConfigModule.forRoot({ validate })` — missing/malformed
 *   values fail loudly with a clear message instead of producing mysterious runtime
 *   bugs hours later.
 * - All keys are flat (no nested namespaces) so `configService.get('STRIPE_SECRET_KEY')`
 *   matches the actual env var name 1:1.
 * - Optional values are explicit; required values without defaults will reject startup.
 */
export const envSchema = z.object({
	// Core
	NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
	DATABASE_URL: z.string(),
	API_PORT: z.coerce.number().default(3001),
	WEB_ORIGIN: z.url().default('http://localhost:3000'),

	// Auth.js (consumed at module-init time by auth.config.ts; ConfigService can't reach
	// that file, but we still validate the values here so a typo in .env fails fast.)
	AUTH_SECRET: z.string().min(32),
	AUTH_URL: z.url(),
	AUTH_TRUST_HOST: z.coerce.boolean().default(true),

	// Encryption key for OAuth tokens stored on Account rows. 32 bytes hex-encoded.
	// Generate with: `openssl rand -hex 32`. NEVER reuse across environments — leaking
	// it from staging would let staging readers decrypt prod tokens if you copy DB dumps.
	TOKEN_ENCRYPTION_KEY: z
		.string()
		.length(64, 'must be 64 hex chars (32 bytes — generate with `openssl rand -hex 32`)')
		.regex(/^[0-9a-fA-F]+$/, 'must be hex'),

	// Resend (email)
	RESEND_API_KEY: z.string().optional(),
	RESEND_EMAIL_FROM: z.string().email().default('onboarding@resend.dev'),

	// Google OAuth — optional, only enabled when both are set. Serves TWO purposes from
	// the same Google Cloud OAuth client:
	//   1. Auth.js sign-in (scopes: openid email profile) → callback /api/auth/callback/google.
	//   2. Gmail inbox connect (scopes: gmail.readonly + gmail.send) → callback /api/email/gmail/callback.
	// Both redirect URIs must be registered in the Google Cloud Console for this client.
	GOOGLE_CLIENT_ID: z.string().optional(),
	GOOGLE_CLIENT_SECRET: z.string().optional(),

	// Microsoft Entra — optional
	MICROSOFT_CLIENT_ID: z.string().optional(),
	MICROSOFT_CLIENT_SECRET: z.string().optional(),
	MICROSOFT_TENANT_ID: z.string().default('common'),

	// Stripe billing
	STRIPE_SECRET_KEY: z.string().optional(),
	STRIPE_PRICE_ID: z.string().optional(),
	STRIPE_WEBHOOK_SECRET: z.string().optional(),

	// Inngest — workers + scheduled jobs
	// In dev the Inngest CLI (`npx inngest-cli@latest dev`) handles auth at the localhost
	// boundary, so both of these may be empty. In production:
	//  - INNGEST_EVENT_KEY  → required when sending events to Inngest Cloud.
	//  - INNGEST_SIGNING_KEY → required for the cloud handler to verify it's really us.
	INNGEST_EVENT_KEY: z.string().optional(),
	INNGEST_SIGNING_KEY: z.string().optional()
});

export type EnvSchema = z.infer<typeof envSchema>;

/**
 * Validate function for `ConfigModule.forRoot({ validate })`. Throws a single error
 * listing every invalid/missing var so you fix them all at once instead of one-at-a-time.
 */
export function validateEnv(config: Record<string, unknown>): EnvSchema {
	const result = envSchema.safeParse(config);
	if (!result.success) {
		const issues = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');

		throw new Error(`Invalid environment configuration:\n${issues}`);
	}

	return result.data;
}
