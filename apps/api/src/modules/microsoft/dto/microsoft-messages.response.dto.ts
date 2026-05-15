import type { MicrosoftMessage, MicrosoftMessages } from '@quoteom/shared';

export class MicrosoftMessageDto implements MicrosoftMessage {
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

export class MicrosoftMessagesResponseDto implements MicrosoftMessages {
	messages!: MicrosoftMessageDto[];
}
