import type { OkResponse } from '@quoteom/shared';

export class GmailDisconnectResponseDto implements OkResponse {
	ok!: boolean;
}
