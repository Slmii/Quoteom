import type { GmailMessage, GmailMessages } from '@quoteom/shared';

export class GmailMessageDto implements GmailMessage {
	id!: string;
	threadId!: string;
	/** Provider's `internalDate` rendered as ISO. */
	internalDate!: string;
	snippet!: string;
	subject!: string | null;
	from!: string | null;
}

export class GmailMessagesResponseDto implements GmailMessages {
	messages!: GmailMessageDto[];
}
