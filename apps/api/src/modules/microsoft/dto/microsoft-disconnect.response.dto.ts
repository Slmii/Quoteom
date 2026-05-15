import type { OkResponse } from '@quoteom/shared';

export class MicrosoftDisconnectResponseDto implements OkResponse {
	ok!: boolean;
}
