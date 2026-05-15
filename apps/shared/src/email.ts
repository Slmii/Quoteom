/**
 * Email provider tag. Mirrors Prisma's `EmailProvider` enum — declared here as a string
 * union (not re-exported from Prisma) for the same reason as `MembershipRole`: keep the
 * Prisma runtime out of the web bundle.
 */
export type EmailProvider = 'GMAIL' | 'MICROSOFT';

/**
 * `GET /api/email/gmail/status` and `GET /api/email/microsoft/status` response shape.
 * Identical between providers — the BE DTOs (`GmailStatusResponseDto`, `MicrosoftStatusResponseDto`)
 * both implement this interface.
 */
export interface MailboxStatus {
	connected: boolean;
	/** Mailbox address when connected; `null` otherwise. */
	email: string | null;
	/** ISO timestamp when the OAuth handshake completed; `null` otherwise. */
	connectedAt: string | null;
}

/** One Gmail message preview shape (recent-list endpoint). */
export interface GmailMessage {
	id: string;
	threadId: string;
	/** Provider's `internalDate` rendered as ISO. */
	internalDate: string;
	snippet: string;
	subject: string | null;
	from: string | null;
}

/** `GET /api/email/gmail/messages` wire-format response (just the messages array). */
export interface GmailMessages {
	messages: GmailMessage[];
}

/** One Microsoft Graph message preview shape (recent-list endpoint). */
export interface MicrosoftMessage {
	id: string;
	conversationId: string;
	/** ISO timestamp (Graph's `receivedDateTime` is already ISO). */
	receivedDateTime: string;
	/** Graph's `bodyPreview` — first ~255 chars of plain text. */
	bodyPreview: string;
	subject: string | null;
	fromEmail: string | null;
	fromName: string | null;
}

/** `GET /api/email/microsoft/messages` wire-format response. */
export interface MicrosoftMessages {
	messages: MicrosoftMessage[];
}
