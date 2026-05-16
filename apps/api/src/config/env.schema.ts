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
	// Only required on PROD
	AUTH_URL: z.url().optional(),
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
	// W3.5 — Pub/Sub topic Gmail pushes notifications to. Full resource name:
	// `projects/<gcp-project>/topics/<topic>`. Optional: when unset (typical local dev
	// without GCP setup), GmailWatchService no-ops watch start + renewal so the rest of
	// the inbox flow still works. Set this once you've provisioned the topic in step 2
	// of the W3.5 staged execution plan.
	GOOGLE_PUBSUB_TOPIC: z.string().optional(),
	// W3.5 — Expected `aud` claim on the JWT Pub/Sub signs and sends with every push
	// delivery. Set when creating the push subscription. Typically the full webhook URL
	// (e.g. `https://app.quoteom.com/api/email/gmail/webhook`). Optional in dev — if
	// unset the webhook returns 503 so misconfigured-prod doesn't silently swallow pushes.
	GOOGLE_PUBSUB_AUDIENCE: z.string().optional(),
	// W3.5 — `email` claim on the JWT. Pub/Sub's service account for the GCP project,
	// e.g. `service-NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com`. Pin it to prevent any
	// other Google-signed JWT with our audience from being accepted. Optional in dev.
	GOOGLE_PUBSUB_SERVICE_ACCOUNT: z.string().optional(),

	// Microsoft Entra — optional
	MICROSOFT_CLIENT_ID: z.string().optional(),
	MICROSOFT_CLIENT_SECRET: z.string().optional(),
	MICROSOFT_TENANT_ID: z.string().default('common'),
	// Public URL Microsoft Graph posts push notifications to. Mirrors the
	// `GOOGLE_PUBSUB_TOPIC` env in role: when unset (typical local dev without ngrok),
	// `MicrosoftSubscriptionService` no-ops subscription start + renewal so the rest of
	// the inbox flow still works. Full URL including scheme + path, e.g.
	// `https://app.quoteom.com/api/email/microsoft/webhook`.
	MICROSOFT_GRAPH_NOTIFICATION_URL: z.string().optional(),

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
	INNGEST_SIGNING_KEY: z.string().optional(),

	// W4.1 — AI provider (OpenAI / Azure OpenAI).
	// Direct OpenAI mode: leave AZURE_OPENAI_* unset; the client hits api.openai.com using
	// `OPENAI_API_KEY`. Easiest signup, US-routed by default.
	// Azure OpenAI mode (EU data residency): set `AZURE_OPENAI_ENDPOINT` to your Azure
	// resource URL (e.g. `https://quoteom.openai.azure.com`); the client switches to Azure
	// routing using `AZURE_OPENAI_API_KEY` (falls back to OPENAI_API_KEY if unset).
	// Both keys optional in dev — when missing, the AI module's `generate()` throws a clear
	// "OpenAI not configured" error rather than silently using a fake.
	OPENAI_API_KEY: z.string().optional(),
	OPENAI_MODEL_CLASSIFIER: z.string().default('gpt-4o-mini'),
	OPENAI_MODEL_EXTRACTOR: z.string().default('gpt-4o'),
	AZURE_OPENAI_ENDPOINT: z.string().optional(),
	AZURE_OPENAI_API_KEY: z.string().optional(),
	// Azure pins the API version per request. We use OpenAI's Responses API (recommended
	// for new projects); Azure Responses-API support was added in `2025-03-01-preview`.
	// Bump only when a GA version with Responses-API parity ships; chasing preview tags
	// has historically been more pain than benefit for stability.
	AZURE_OPENAI_API_VERSION: z.string().default('2025-03-01-preview')
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
