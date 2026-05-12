import type { MembershipRole } from '@/generated/prisma/client';

export class InvitationResponseDto {
	id!: string;
	email!: string;
	role!: MembershipRole;
	expiresAt!: Date;
	createdAt!: Date;
}
