import type { MembershipRole } from '@/generated/prisma/client';

/**
 * Doesn't `implements Invitation` from `@quoteom/shared` because that interface types
 * `expiresAt` / `createdAt` as `string` (wire format), while this class keeps them as
 * `Date` for direct Prisma row pass-through. Runtime JSON serialization converts
 * Date → ISO string on the wire.
 */
export class InvitationResponseDto {
	id!: string;
	email!: string;
	role!: MembershipRole;
	expiresAt!: Date;
	createdAt!: Date;
}
