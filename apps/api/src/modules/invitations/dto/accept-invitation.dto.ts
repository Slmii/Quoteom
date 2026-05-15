import type { AcceptInvitationInput } from '@quoteom/shared';
import { IsHexadecimal, IsString, Length } from 'class-validator';

/**
 * Invitation tokens are always 64 hex chars (`randomBytes(32).toString('hex')` in
 * `InvitationsService.create`). Pinning to the exact length + hex shape rejects garbage
 * inputs at the DTO layer before any Prisma lookup runs.
 */
export class AcceptInvitationDto implements AcceptInvitationInput {
	@IsString()
	@Length(64, 64)
	@IsHexadecimal()
	token!: string;
}
