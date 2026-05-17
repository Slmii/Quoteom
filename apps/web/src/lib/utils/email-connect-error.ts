/**
 * Maps the structured `?error=<code>` values that the Gmail/Microsoft OAuth callbacks
 * redirect with into friendly UI copy. The API never sends a 500 to the browser for
 * OAuth-callback failures — it logs the underlying provider error and bounces back to
 * `/settings/email?error=<code>` with one of these stable codes.
 *
 * Codes are mirrored from `apps/api/src/lib/errors.ts#EmailConnectErrorCode`. Adding a
 * new code on the API side without adding the matching entry here makes the UI fall
 * back to `UNKNOWN_COPY`.
 */

export const EMAIL_CONNECT_ERROR_COPY: Record<string, { title: string; description: string }> = {
	oauth_state_mismatch: {
		title: 'Your connection got mixed up.',
		description:
			'This usually happens if the browser took an unexpected detour during sign-in. Try connecting again from this page.'
	},
	oauth_code_missing: {
		title: 'The provider didn’t complete the connection.',
		description:
			'No authorization code came back from Google/Microsoft. Try connecting again — the most common cause is closing or refreshing the consent page early.'
	},
	oauth_code_invalid: {
		title: 'That authorization expired.',
		description:
			'The one-time code from Google/Microsoft can only be used once and only within a short window. Just click Connect again — it should work the second time.'
	},
	oauth_token_exchange_failed: {
		title: 'We couldn’t finish the connection.',
		description:
			'Google or Microsoft refused our request to complete the connection. Try again in a minute. If this keeps happening, contact support.'
	},
	oauth_userinfo_failed: {
		title: 'We connected, but couldn’t read your account details.',
		description:
			'The provider didn’t return your email/profile after you signed in. Try connecting again. If it keeps failing, your inbox account may need to be re-granted permissions.'
	},
	oauth_provider_rejected: {
		title: 'Google/Microsoft cancelled the connection.',
		description:
			'You may have clicked Cancel, or the provider blocked the sign-in. Start the connect flow again to retry.'
	},
	oauth_provider_misconfigured: {
		title: 'Mailbox connection is temporarily unavailable.',
		description:
			'Our server is missing some required configuration for connecting mailboxes. This is on our end — please contact support.'
	},
	oauth_unknown_error: {
		title: 'Something went wrong while connecting your mailbox.',
		description: 'Try connecting again. If it keeps failing, contact support.'
	}
} as const;

export const UNKNOWN_EMAIL_CONNECT_ERROR_COPY: { title: string; description: string } = {
	title: 'Something went wrong while connecting your mailbox.',
	description: 'Try connecting again. If it keeps failing, contact support.'
};

export function getEmailConnectErrorCopy(code: string | undefined): {
	title: string;
	description: string;
} | null {
	if (!code) {
		return null;
	}
	return EMAIL_CONNECT_ERROR_COPY[code] ?? UNKNOWN_EMAIL_CONNECT_ERROR_COPY;
}
