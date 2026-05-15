import type { AcceptInvitationResponse } from '@quoteom/shared';

export class AcceptInvitationResponseDto implements AcceptInvitationResponse {
	userId!: string;
	email!: string;
	organizationId!: string;
	organizationName!: string;
}
