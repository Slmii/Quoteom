import type { EnvSchema } from '@/config/env.schema';
import { MembershipRole } from '@/generated/prisma/client';
import {
	INVITATION_ALREADY_ACCEPTED,
	INVITATION_ALREADY_PENDING,
	INVITATION_EXPIRED,
	INVITATION_NOT_FOUND,
	ORGANIZATION_NOT_FOUND,
	OWNER_ROLE_NOT_INVITABLE,
	trialSeatLimitReached,
	USER_ALREADY_MEMBER
} from '@/lib/errors';
import { buildInviteEmail } from '@/lib/mails/invite.email';
import { sendEmail } from '@/lib/mails/send';
import { SEATS_INCLUDED, TRIAL_SEAT_LIMIT_CODE, TRIAL_STATES } from '@/modules/billing/billing.constants';
import { BillingService } from '@/modules/billing/billing.service';
import { AcceptInvitationResponseDto } from '@/modules/invitations/dto/accept-invitation.response.dto';
import { InvitationResponseDto } from '@/modules/invitations/dto/invitation.response.dto';
import { LogService } from '@/modules/logger/log.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import {
	BadRequestException,
	ConflictException,
	GoneException,
	HttpException,
	HttpStatus,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';

const INVITATION_TTL_DAYS = 7;
const INVITATION_TOKEN_BYTES = 32;

interface CreateInvitationInput {
	email: string;
	organizationId: string;
	role?: MembershipRole;
}

@Injectable()
export class InvitationsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly config: ConfigService<EnvSchema, true>,
		private readonly billing: BillingService,
		private readonly logService: LogService
	) {}

	async create(input: CreateInvitationInput): Promise<InvitationResponseDto> {
		// Normalize once at the boundary. Emails are case-insensitive in practice (RFC 5321
		// allows case-sensitive local parts but no real mail server treats them that way),
		// and Postgres's unique constraint is case-sensitive — so storing mixed case would
		// produce phantom duplicates. Lowercase everywhere on write; lookups stay
		// case-insensitive defensively.
		const email = input.email.trim().toLowerCase();

		const organization = await this.prisma.organization.findUnique({
			where: { id: input.organizationId }
		});

		if (!organization) {
			throw new NotFoundException(ORGANIZATION_NOT_FOUND);
		}

		// Defensive: DTO validation already rejects OWNER, but keep the service-level guard
		// so internal/admin callers that bypass the controller can't break the invariant.
		if (input.role === MembershipRole.OWNER) {
			throw new BadRequestException(OWNER_ROLE_NOT_INVITABLE);
		}

		await this.assertEmailNotTaken(email, input.organizationId);
		await this.assertSeatBudget(input.organizationId);

		const token = randomBytes(INVITATION_TOKEN_BYTES).toString('hex');
		const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

		const invitation = await this.prisma.invitation.create({
			data: {
				token,
				email,
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
			to: email,
			subject,
			html,
			text,
			devFallbackLog: `Invite for ${email} to ${organization.name}:\n  ${url}`
		});

		this.logService.logAction({
			action: 'invitation.created',
			message: `Invitation sent to ${email} for ${organization.name}`,
			metadata: {
				organizationId: input.organizationId,
				invitationId: invitation.id,
				inviteeEmail: email,
				role: invitation.role
			},
			context: 'InvitationsService'
		});

		return {
			id: invitation.id,
			email: invitation.email,
			role: invitation.role,
			expiresAt: invitation.expiresAt,
			createdAt: invitation.createdAt
		};
	}

	/** Pending = not yet accepted and not yet expired. Powers the /team UI list. */
	async listPending(organizationId: string): Promise<InvitationResponseDto[]> {
		const rows = await this.prisma.invitation.findMany({
			where: {
				organizationId,
				acceptedAt: null,
				expiresAt: { gt: new Date() }
			},
			orderBy: { createdAt: 'desc' },
			select: {
				id: true,
				email: true,
				role: true,
				expiresAt: true,
				createdAt: true
			}
		});
		return rows;
	}

	/** Revoke a pending invitation. No-op if already accepted (idempotent on the UI side). */
	async revoke(invitationId: string, organizationId: string): Promise<void> {
		const invitation = await this.prisma.invitation.findUnique({
			where: { id: invitationId }
		});
		if (!invitation || invitation.organizationId !== organizationId) {
			throw new NotFoundException(INVITATION_NOT_FOUND);
		}
		if (invitation.acceptedAt) {
			throw new ConflictException(INVITATION_ALREADY_ACCEPTED);
		}
		await this.prisma.invitation.delete({ where: { id: invitationId } });
		this.logService.logAction({
			action: 'invitation.revoked',
			message: `Invitation for ${invitation.email} revoked`,
			metadata: { organizationId, invitationId: invitation.id, inviteeEmail: invitation.email },
			context: 'InvitationsService'
		});
	}

	async accept(token: string): Promise<AcceptInvitationResponseDto> {
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

		const normalizedEmail = invitation.email.trim().toLowerCase();

		const result = await this.prisma.$transaction(async tx => {
			// Case-insensitive lookup so legacy rows with mixed-case emails still match.
			// `findUnique` is case-sensitive on a plain text unique index, so combine an
			// insensitive `findFirst` (handles legacy data) with an explicit create when
			// no row exists.
			const existing = await tx.user.findFirst({
				where: { email: { equals: normalizedEmail, mode: 'insensitive' } }
			});

			const user =
				existing ??
				(await tx.user.create({
					data: {
						email: normalizedEmail,
						currentOrganizationId: invitation.organizationId
					}
				}));

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
				email: normalizedEmail,
				organizationId: invitation.organizationId,
				organizationName: invitation.organization.name
			};
		});

		// Reconcile Stripe's billed quantity with the new membership count. Best-effort: if
		// the API is unreachable, the invitation already committed — we log and move on.
		// A subsequent sync (next invite, or a webhook-driven re-sync) will fix the drift.
		await this.billing.syncSeatCount(result.organizationId);

		this.logService.logAction({
			action: 'invitation.accepted',
			message: `${result.email} joined ${result.organizationName}`,
			metadata: {
				organizationId: result.organizationId,
				invitationId: invitation.id,
				userId: result.userId,
				inviteeEmail: result.email,
				role: invitation.role
			},
			context: 'InvitationsService'
		});

		return result;
	}

	/**
	 * Reject duplicate invitations for an email that's already a member or already has a
	 * pending invitation on this org. Case-insensitive — Auth.js stores email as-typed,
	 * but treat `John@Example.com` and `john@example.com` as the same person.
	 *
	 * Expired pending invitations are intentionally ignored: re-inviting after expiry is
	 * the expected recovery path, not a duplicate.
	 */
	private async assertEmailNotTaken(email: string, organizationId: string): Promise<void> {
		const [existingMember, existingPending] = await Promise.all([
			this.prisma.membership.findFirst({
				where: {
					organizationId,
					user: { email: { equals: email, mode: 'insensitive' } }
				},
				select: { id: true }
			}),
			this.prisma.invitation.findFirst({
				where: {
					organizationId,
					email: { equals: email, mode: 'insensitive' },
					acceptedAt: null,
					expiresAt: { gt: new Date() }
				},
				select: { id: true }
			})
		]);

		if (existingMember) {
			throw new ConflictException(USER_ALREADY_MEMBER);
		}

		if (existingPending) {
			throw new ConflictException(INVITATION_ALREADY_PENDING);
		}
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

		this.logService.logAction({
			action: 'invitation.rejected.trial_seat_cap',
			message: `Trial seat cap reached for org ${organizationId} (${memberCount} members + ${pendingInvites} pending)`,
			metadata: {
				organizationId,
				cap: SEATS_INCLUDED,
				memberCount,
				pendingInvites
			},
			level: 'warn',
			context: 'InvitationsService'
		});

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
