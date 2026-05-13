export class MicrosoftMessageDto {
	id!: string;
	conversationId!: string;
	/** ISO timestamp (Graph's `receivedDateTime` is already ISO). */
	receivedDateTime!: string;
	/** Graph's `bodyPreview` — first ~255 chars of plain text. */
	bodyPreview!: string;
	subject!: string | null;
	fromEmail!: string | null;
	fromName!: string | null;
}

export class MicrosoftMessagesResponseDto {
	messages!: MicrosoftMessageDto[];
}
