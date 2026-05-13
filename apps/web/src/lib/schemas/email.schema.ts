import z from 'zod';

/**
 * Search params on /settings/email. Used to surface OAuth callback outcomes:
 *  - `connected=1` after a successful handshake.
 *  - `error=<google error code>` if Google returned an OAuth error.
 *
 * TanStack Router parses search values with `JSON.parse(value)`-then-fallback-to-string,
 * so `?connected=1` arrives as the NUMBER 1 here (not the string "1"). `z.coerce.string()`
 * normalizes both shapes so the component can do a stable `search.connected === '1'` check.
 */
export const EmailSettingsSearchSchema = z.object({
	connected: z.coerce.string().optional(),
	error: z.coerce.string().optional(),
	// Populated when the Microsoft callback detects an admin-consent-required error
	// (Entra AADSTS65001 / 90094 / 900971). The web layer renders the link as-is —
	// the URL is built server-side so we don't need MICROSOFT_CLIENT_ID in the browser bundle.
	adminConsentUrl: z.coerce.string().url().optional()
});
