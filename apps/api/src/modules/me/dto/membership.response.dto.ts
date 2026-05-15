import type { MembershipOrganization, MembershipUser } from '@quoteom/shared';
import type { MembershipRole } from '@/generated/prisma/client';

export class MembershipUserDto implements MembershipUser {
	id!: string;
	email!: string;
	name!: string | null;
}

export class MembershipOrganizationDto implements MembershipOrganization {
	id!: string;
	name!: string;
}

/**
 * Doesn't `implements Membership` from `@quoteom/shared` because that interface types
 * `createdAt` / `updatedAt` as `string` (wire format), while this class keeps them as
 * `Date` to match what Prisma returns directly. Runtime JSON serialization converts
 * Date → ISO string on the wire so the FE still receives the shared-interface shape.
 */
export class MembershipResponseDto {
	id!: string;
	userId!: string;
	organizationId!: string;
	role!: MembershipRole;
	createdAt!: Date;
	updatedAt!: Date;
	user!: MembershipUserDto;
	organization!: MembershipOrganizationDto;
}
