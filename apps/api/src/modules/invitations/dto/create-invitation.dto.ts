import { MembershipRole } from '@/generated/prisma/client';
import { OWNER_ROLE_NOT_INVITABLE } from '@/lib/errors';
import { IsEmail, IsEnum, IsIn, IsOptional } from 'class-validator';

/**
 * Roles that can be assigned to a newly-invited teammate. OWNER is excluded — an org
 * has exactly one owner (set at org creation). Ownership transfer is a separate flow.
 */
const INVITABLE_ROLES: ReadonlyArray<MembershipRole> = [MembershipRole.MEMBER, MembershipRole.EXTERNAL];

export class CreateInvitationDto {
	@IsEmail()
	email!: string;

	// `@IsEnum` rejects unknown values with a generic message; `@IsIn` narrows further to
	// the invitable subset and surfaces the owner-specific message when OWNER is sent.
	@IsOptional()
	@IsEnum(MembershipRole)
	@IsIn(INVITABLE_ROLES, { message: OWNER_ROLE_NOT_INVITABLE })
	role?: MembershipRole;
}
