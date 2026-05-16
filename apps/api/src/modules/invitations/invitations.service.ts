import type { EnvSchema } from '@/config/env.schema';
import { MembershipRole } from '@/generated/prisma/client';
import { isOrganizationEntitled } from '@/lib/billing/entitlement-check';
import {
	INVITATION_ALREADY_ACCEPTED,
	INVITATION_ALREADY_PENDING,
	INVITATION_EXPIRED,
	INVITATION_NOT_FOUND,
	ORGANIZATION_NOT_FOUND,
	OWNER_ROLE_NOT_INVITABLE,
	SUBSCRIPTION_REQUIRED,
	trialSeatLimitReached,
	USER_ALREADY_MEMBER
} from '@/lib/errors';
import { buildInviteEmail } from '@/lib/mails/invite.email';
import { sendEmail } from '@/lib/mails/send';
import {
	BILLING_REQUIRED_CODE,
	SEATS_INCLUDED,
	TRIAL_SEAT_LIMIT_CODE,
	TRIAL_STATES
} from '@/modules/billing/billing.constants';
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
import { createHash, randomBytes } from 'node:crypto';

const INVITATION_TTL_DAYS = 7;
const INVITATION_TOKEN_BYTES = 32;

/**
 * Hash the raw invitation token before it touches the DB. Same defense as password
 * hashing: the token in the email link is the only redeemable form. A DB dump (backup
 * exfil, read-replica leak, ORM injection finding rows) yields the hash, not the
 * redeemable secret. SHA-256 (not bcrypt) is appropriate here because the input is a
 * 256-bit random — there's no entropy to slow-hash and no human-typed prefix to brute.
 */
function hashInvitationToken(rawToken: string): string {
	return createHash('sha256').update(rawToken).digest('hex');
}

interface CreateInvitationInput {
	email: string;
	organizationId: string;
	role?: MembershipRole;
}

// Internal shape returned by the tx — superset of the public DTO with audit-only
// fields the post-tx logAction call needs. Kept private to the function so the
// public DTO stays free of leaking properties.
interface AcceptTxResult {
	userId: string;
	email: string;
	organizationId: string;
	organizationName: string;
	invitationId: string;
	invitationRole: MembershipRole;
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

		const rawToken = randomBytes(INVITATION_TOKEN_BYTES).toString('hex');
		const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

		// `Invitation.token` column stores the SHA-256 hash. The raw token ships in the
		// magic-link URL only — never persisted, never logged.
		const invitation = await this.prisma.invitation.create({
			data: {
				token: hashInvitationToken(rawToken),
				email,
				organizationId: input.organizationId,
				role: input.role ?? MembershipRole.MEMBER,
				expiresAt
			}
		});

		const webOrigin = this.config.get('WEB_ORIGIN', { infer: true });
		const url = `${webOrigin}/accept-invite?token=${rawToken}`;
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

	async accept(rawToken: string): Promise<AcceptInvitationResponseDto> {
		// Tokens are hashed at rest — see `hashInvitationToken` above. Hash the incoming
		// raw token from the URL and look up by the stored hash.
		const tokenHash = hashInvitationToken(rawToken);

		// Lookup + expiry/accepted checks live inside the tx so a concurrent accept on the
		// same token can't both pass. The final invitation update uses a conditional
		// `updateMany` (acceptedAt: null) so the gate is atomic at the DB layer regardless
		// of READ COMMITTED isolation — only one tx can claim the row; the loser gets
		// count=0 and aborts cleanly.
		const txResult = await this.prisma.$transaction(async (tx): Promise<AcceptTxResult> => {
			const invitation = await tx.invitation.findUnique({
				where: { token: tokenHash },
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

			// Block redemption when the inviting org has lost entitlement (canceled / unpaid)
			// between issuance and acceptance. Without this, a pending token from a healthy
			// trial could still seat a new user after the org's subscription ended — adding
			// billable membership rows to a non-paying org. Same 402-shaped body as
			// `EntitlementGuard` so the web client's auto-redirect handler treats it identically.
			if (!(await isOrganizationEntitled(this.prisma, invitation.organizationId))) {
				throw new HttpException(
					{
						statusCode: HttpStatus.PAYMENT_REQUIRED,
						code: BILLING_REQUIRED_CODE,
						message: SUBSCRIPTION_REQUIRED,
						billingPath: '/billing'
					},
					HttpStatus.PAYMENT_REQUIRED
				);
			}

			const normalizedEmail = invitation.email.trim().toLowerCase();

			// Case-insensitive lookup first — handles legacy rows persisted before we
			// normalized emails to lowercase on write. `findUnique` is case-sensitive on the
			// plain text unique index, so we fall back to an insensitive `findFirst`.
			const existing = await tx.user.findFirst({
				where: { email: { equals: normalizedEmail, mode: 'insensitive' } }
			});

			// If no row exists, `upsert` by the (case-sensitive) lowercased email. Using
			// upsert rather than create makes the path idempotent under concurrent accepts —
			// two transactions racing through the same token both end up with the same User
			// row instead of the second one tripping the `User_email_key` unique constraint
			// and aborting the whole transaction (which was the original bug).
			const user =
				existing ??
				(await tx.user.upsert({
					where: { email: normalizedEmail },
					update: {},
					create: {
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

			// Atomic claim: `updateMany` with `acceptedAt: null` in the WHERE clause means
			// only the first concurrent caller wins. The loser sees count=0 and we throw,
			// aborting the whole tx (rolling back membership upsert + any user create).
			// Without this, two concurrent accepts could both pass the line-181 null check
			// (READ COMMITTED isolation) and both succeed at a non-atomic final update.
			const { count } = await tx.invitation.updateMany({
				where: { id: invitation.id, acceptedAt: null },
				data: { acceptedAt: new Date() }
			});
			if (count === 0) {
				throw new ConflictException(INVITATION_ALREADY_ACCEPTED);
			}

			return {
				userId: user.id,
				email: normalizedEmail,
				organizationId: invitation.organizationId,
				organizationName: invitation.organization.name,
				invitationId: invitation.id,
				invitationRole: invitation.role
			};
		});

		// Reconcile Stripe's billed quantity with the new membership count. Best-effort: if
		// the API is unreachable, the invitation already committed — we log and move on.
		// A subsequent sync (next invite, or a webhook-driven re-sync) will fix the drift.
		await this.billing.syncSeatCount(txResult.organizationId);

		this.logService.logAction({
			action: 'invitation.accepted',
			message: `${txResult.email} joined ${txResult.organizationName}`,
			metadata: {
				organizationId: txResult.organizationId,
				invitationId: txResult.invitationId,
				userId: txResult.userId,
				inviteeEmail: txResult.email,
				role: txResult.invitationRole
			},
			context: 'InvitationsService'
		});

		// Project only public DTO fields — `invitationId` / `invitationRole` were audit-
		// only and stay out of the response.
		return {
			userId: txResult.userId,
			email: txResult.email,
			organizationId: txResult.organizationId,
			organizationName: txResult.organizationName
		};
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
