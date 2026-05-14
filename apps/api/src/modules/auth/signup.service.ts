import { MembershipRole } from '@/generated/prisma/client';
import { ACCOUNT_ALREADY_EXISTS } from '@/lib/errors';
import { LogService } from '@/modules/logger/log.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { ConflictException, Injectable } from '@nestjs/common';

interface SignupResult {
	userId: string;
	organizationId: string;
	email: string;
}

/**
 * Self-signup: provision a new User + Organization + OWNER Membership in one transaction.
 *
 * Pattern A from the design discussion — every signup creates a fresh org. If a teammate
 * needs to join an existing org, the OWNER invites them via `/team` instead. This
 * sidesteps the "two orgs for the same company" duplicate-org sprawl problem at the cost
 * of one extra step for the 2nd-Nth person on a team.
 *
 * Magic-link delivery is NOT triggered here — the client follows up with the existing
 * Auth.js signin endpoint (`/api/auth/signin/resend`) once this returns. Keeps the
 * Auth.js token + CSRF machinery in one place rather than duplicating it server-side.
 */
@Injectable()
export class SignupService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly logService: LogService
	) {}

	async signup(rawEmail: string, rawCompanyName: string): Promise<SignupResult> {
		const email = rawEmail.trim().toLowerCase();
		const companyName = rawCompanyName.trim();

		// Fast-path duplicate check before doing transaction work. Case-INsensitive so
		// legacy mixed-case rows (e.g. invitations accepted before normalization landed)
		// still match. The pre-tx check is best-effort — the TOCTOU race below catches
		// concurrent signups that both pass this gate.
		const existing = await this.prisma.user.findFirst({
			where: { email: { equals: email, mode: 'insensitive' } },
			select: { id: true }
		});
		if (existing) {
			this.logService.logAction({
				action: 'signup.rejected.duplicate_email',
				message: `Signup rejected — account already exists for ${email}`,
				metadata: { email },
				level: 'warn',
				context: 'SignupService'
			});
			throw new ConflictException(ACCOUNT_ALREADY_EXISTS);
		}

		let result: SignupResult;
		try {
			result = await this.prisma.$transaction(async tx => {
				const organization = await tx.organization.create({
					data: { name: companyName }
				});

				const user = await tx.user.create({
					data: {
						email,
						currentOrganizationId: organization.id
					}
				});

				await tx.membership.create({
					data: {
						userId: user.id,
						organizationId: organization.id,
						role: MembershipRole.OWNER
					}
				});

				return { userId: user.id, organizationId: organization.id, email };
			});
		} catch (error) {
			// TOCTOU: two concurrent signups for the same email both pass the pre-tx
			// findFirst check. The loser's `tx.user.create` trips the User.email unique
			// constraint → Prisma P2002. Without this catch the user sees a 500 with a
			// raw Prisma error message instead of the clean 409 ConflictException.
			if (isUserEmailUniqueConstraintError(error)) {
				this.logService.logAction({
					action: 'signup.rejected.duplicate_email',
					message: `Signup race lost — duplicate email ${email} (P2002)`,
					metadata: { email, reason: 'p2002_race' },
					level: 'warn',
					context: 'SignupService'
				});
				throw new ConflictException(ACCOUNT_ALREADY_EXISTS);
			}
			throw error;
		}

		this.logService.logAction({
			action: 'signup.org_created',
			message: `New org created: "${companyName}" by ${email}`,
			metadata: {
				userId: result.userId,
				organizationId: result.organizationId,
				email: result.email,
				companyName
			},
			context: 'SignupService'
		});

		return result;
	}
}

/**
 * Duck-typed check for Prisma's P2002 (Unique constraint failed) specifically on the
 * `User.email` column. Avoids importing `Prisma.PrismaClientKnownRequestError` to keep
 * the import surface aligned with the `isResourceMissingError` pattern used by
 * `BillingService` for Stripe's `resource_missing`.
 *
 * Why the `target` check: today `User.email` is the only unique column the signup tx can
 * trip. But a future schema change (e.g. adding a unique on `Organization.name`) would
 * silently get mis-translated to `ACCOUNT_ALREADY_EXISTS` — wrong user-facing error.
 * Pin to the email target so any other unique violation propagates as a generic 500
 * instead of a misleading 409.
 */
function isUserEmailUniqueConstraintError(error: unknown): boolean {
	if (!(error instanceof Error) || !('code' in error)) {
		return false;
	}
	const typed = error as { code?: unknown; meta?: { target?: unknown } };
	if (typed.code !== 'P2002') {
		return false;
	}
	const target = typed.meta?.target;
	return Array.isArray(target) && target.includes('email');
}
