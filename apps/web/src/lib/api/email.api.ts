import { serverFetch } from '@/lib/api/server-fetch';
import type { GmailMessage, GmailMessages, MailboxStatus, MicrosoftMessage, MicrosoftMessages } from '@quoteom/shared';
import { createServerFn } from '@tanstack/react-start';

/**
 * FE view-model wrapper around the wire-format `GmailMessages` — adds a `disconnected` flag
 * the server doesn't return. The flag is synthesized client-side when the messages endpoint
 * 404s (the EmailAccount row was self-healed away mid-request), so the UI can reconcile
 * with a stale-but-cached "connected" status response without an extra round-trip.
 */
export interface GmailMessagesView extends GmailMessages {
	disconnected: boolean;
}

/** FE view-model wrapper around `MicrosoftMessages`. Same pattern as `GmailMessagesView`. */
export interface MicrosoftMessagesView extends MicrosoftMessages {
	disconnected: boolean;
}

export const getGmailStatusServer = createServerFn({ method: 'GET' }).handler(async (): Promise<MailboxStatus> => {
	const response = await serverFetch('/api/email/gmail/status');
	if (!response.ok) {
		throw new Error(`Failed to load Gmail status (${response.status})`);
	}
	return (await response.json()) as MailboxStatus;
});

export const getGmailMessagesServer = createServerFn({ method: 'GET' }).handler(
	async (): Promise<GmailMessagesView> => {
		const response = await serverFetch('/api/email/gmail/messages');
		if (!response.ok) {
			// 404: either the user never connected, OR `withFreshAccessToken` just self-healed
			// a revoked account away mid-request. Either way we render the same UI — surface
			// the `disconnected: true` flag so the page can reconcile with a stale-but-cached
			// "connected" status response.
			if (response.status === 404) {
				return { messages: [], disconnected: true };
			}

			throw new Error(`Failed to load Gmail messages (${response.status})`);
		}

		const data = (await response.json()) as { messages: GmailMessage[] };
		return { messages: data.messages, disconnected: false };
	}
);

export const getMicrosoftStatusServer = createServerFn({ method: 'GET' }).handler(async (): Promise<MailboxStatus> => {
	const response = await serverFetch('/api/email/microsoft/status');
	if (!response.ok) {
		throw new Error(`Failed to load Microsoft status (${response.status})`);
	}
	return (await response.json()) as MailboxStatus;
});

export const getMicrosoftMessagesServer = createServerFn({ method: 'GET' }).handler(
	async (): Promise<MicrosoftMessagesView> => {
		const response = await serverFetch('/api/email/microsoft/messages');
		if (!response.ok) {
			if (response.status === 404) {
				return { messages: [], disconnected: true };
			}

			throw new Error(`Failed to load Microsoft messages (${response.status})`);
		}

		const data = (await response.json()) as { messages: MicrosoftMessage[] };
		return { messages: data.messages, disconnected: false };
	}
);
