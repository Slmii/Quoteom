import type { MailboxStatus } from '@quoteom/shared';

export class GmailStatusResponseDto implements MailboxStatus {
	connected!: boolean;
	/** Mailbox address when connected; `null` otherwise. */
	email!: string | null;
	/** ISO timestamp when the OAuth handshake completed; `null` otherwise. */
	connectedAt!: string | null;
}
