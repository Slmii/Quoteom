export class MicrosoftStatusResponseDto {
	connected!: boolean;
	/** Mailbox address when connected; `null` otherwise. */
	email!: string | null;
	/** ISO timestamp when the OAuth handshake completed; `null` otherwise. */
	connectedAt!: string | null;
}
