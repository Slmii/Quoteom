import type { EnvSchema } from '@/config/env.schema';
import { MembershipRole } from '@/generated/prisma/client';
import {
	INVITATION_ALREADY_ACCEPTED,
	INVITATION_EXPIRED,
	INVITATION_NOT_FOUND,
	ORGANIZATION_NOT_FOUND,
	trialSeatLimitReached
} from '@/lib/errors';
import { buildInviteEmail } from '@/lib/mails/invite.email';
import { sendEmail } from '@/lib/mails/send';
import { SEATS_INCLUDED, TRIAL_SEAT_LIMIT_CODE, TRIAL_STATES } from '@/modules/billing/billing.constants';
import { BillingService } from '@/modules/billing/billing.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import {
	ConflictException,
	GoneException,
	HttpException,
	HttpStatus,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';

const INVITATION_TTL_DAYS = 7;
const INVITATION_TOKEN_BYTES = 32;

interface CreateInvitationInput {
	email: string;
	organizationId: string;
	role?: MembershipRole;
}

export interface AcceptResult {
	userId: string;
	email: string;
	organizationId: string;
	organizationName: string;
}

@Injectable()
export class InvitationsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly config: ConfigService<EnvSchema, true>,
		private readonly billing: BillingService
	) {}

	async create(input: CreateInvitationInput): Promise<{ id: string; token: string }> {
		const organization = await this.prisma.organization.findUnique({
			where: { id: input.organizationId }
		});

		if (!organization) {
			throw new NotFoundException(ORGANIZATION_NOT_FOUND);
		}

		await this.assertSeatBudget(input.organizationId);

		const token = randomBytes(INVITATION_TOKEN_BYTES).toString('hex');
		const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

		const invitation = await this.prisma.invitation.create({
			data: {
				token,
				email: input.email,
				organizationId: input.organizationId,
				role: input.role ?? MembershipRole.MEMBER,
				expiresAt
			}
		});

		const webOrigin = this.config.get('WEB_ORIGIN', { infer: true });
		const url = `${webOrigin}/accept-invite?token=${token}`;
		const { subject, html, text } = buildInviteEmail({
			url,
			organizationName: organization.name
		});

		await sendEmail({
			to: input.email,
			subject,
			html,
			text,
			devFallbackLog: `Invite for ${input.email} to ${organization.name}:\n  ${url}`
		});

		return { id: invitation.id, token: invitation.token };
	}

	async accept(token: string): Promise<AcceptResult> {
		const invitation = await this.prisma.invitation.findUnique({
			where: { token },
			include: { organization: true }
		});

		if (!invitation) {
			throw new NotFoundException(INVITATION_NOT_FOUND);
		}

		if (invitation.acceptedAt) {
			throw new ConflictException(INVITATION_ALREADY_ACCEPTED);
		}

		if (invitation.expiresAt < new Date()) {
			throw new GoneException(INVITATION_EXPIRED);
		}

		const result = await this.prisma.$transaction(async tx => {
			const user = await tx.user.upsert({
				where: { email: invitation.email },
				update: {},
				create: {
					email: invitation.email,
					currentOrganizationId: invitation.organizationId
				}
			});

			// First-time user with no active org → pin to this one.
			if (!user.currentOrganizationId) {
				await tx.user.update({
					where: { id: user.id },
					data: { currentOrganizationId: invitation.organizationId }
				});
			}

			await tx.membership.upsert({
				where: {
					userId_organizationId: {
						userId: user.id,
						organizationId: invitation.organizationId
					}
				},
				update: {},
				create: {
					userId: user.id,
					organizationId: invitation.organizationId,
					role: invitation.role
				}
			});

			await tx.invitation.update({
				where: { id: invitation.id },
				data: { acceptedAt: new Date() }
			});

			return {
				userId: user.id,
				email: invitation.email,
				organizationId: invitation.organizationId,
				organizationName: invitation.organization.name
			};
		});

		// Reconcile Stripe's billed quantity with the new membership count. Best-effort: if
		// the API is unreachable, the invitation already committed — we log and move on.
		// A subsequent sync (next invite, or a webhook-driven re-sync) will fix the drift.
		await this.billing.syncSeatCount(result.organizationId);

		return result;
	}

	/**
	 * Block new invitations once a trial org reaches `SEATS_INCLUDED`. Counts both active
	 * memberships and pending (un-accepted, un-expired) invitations — otherwise an owner
	 * could fan out 20 invites during trial and let each accept push the count past 3.
	 *
	 * Skipped for paying orgs (`active | past_due | paused | incomplete`): they pay overage
	 * for any seat beyond the included tier.
	 */
	private async assertSeatBudget(organizationId: string): Promise<void> {
		const status = await this.billing.getStatus(organizationId);
		if (!TRIAL_STATES.includes(status.state)) {
			return;
		}

		const [memberCount, pendingInvites] = await Promise.all([
			this.prisma.membership.count({ where: { organizationId } }),
			this.prisma.invitation.count({
				where: {
					organizationId,
					acceptedAt: null,
					expiresAt: { gt: new Date() }
				}
			})
		]);

		if (memberCount + pendingInvites < SEATS_INCLUDED) {
			return;
		}

		throw new HttpException(
			{
				statusCode: HttpStatus.PAYMENT_REQUIRED,
				code: TRIAL_SEAT_LIMIT_CODE,
				message: trialSeatLimitReached(SEATS_INCLUDED),
				billingPath: '/billing'
			},
			HttpStatus.PAYMENT_REQUIRED
		);
	}
}
