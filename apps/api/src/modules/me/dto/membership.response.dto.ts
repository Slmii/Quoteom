import { MembershipRole } from '@/generated/prisma/client';

export class MembershipUserDto {
	id!: string;
	email!: string;
	name!: string | null;
}

export class MembershipResponseDto {
	id!: string;
	userId!: string;
	organizationId!: string;
	role!: MembershipRole;
	createdAt!: Date;
	updatedAt!: Date;
	user!: MembershipUserDto;
}
