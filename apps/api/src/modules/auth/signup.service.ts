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

		// Block before doing transaction work. Case-insensitive — the User.email column is
		// case-sensitive in Postgres but Auth.js + our own InvitationsService both normalize
		// to lowercase, so checking the normalized form is enough.
		const existing = await this.prisma.user.findUnique({
			where: { email },
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

		const result = await this.prisma.$transaction(async tx => {
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
