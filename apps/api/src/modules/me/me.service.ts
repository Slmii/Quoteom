import { MembershipRole } from '@/generated/prisma/client';
import {
	CANNOT_REMOVE_OWNER,
	CANNOT_REMOVE_SELF,
	MEMBERSHIP_NOT_FOUND
} from '@/lib/errors';
import { BillingService } from '@/modules/billing/billing.service';
import { LogService } from '@/modules/logger/log.service';
import { MembershipResponseDto } from '@/modules/me/dto/membership.response.dto';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

/**
 * Reads + writes scoped to the current user. Controller stays thin — orchestrates
 * `request.organizationId` (set by OrganizationGuard) and `request.authSession.user.id`
 * into these methods and returns the result.
 */
@Injectable()
export class MeService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly billing: BillingService,
		private readonly logService: LogService
	) {}

	private static readonly MEMBERSHIP_INCLUDE = {
		user: { select: { id: true, email: true, name: true } },
		organization: { select: { id: true, name: true } }
	} as const;

	/** All members of the given org (teammates of the current user). */
	listOrgMembers(organizationId: string): Promise<MembershipResponseDto[]> {
		return this.prisma.membership.findMany({
			where: { organizationId },
			include: MeService.MEMBERSHIP_INCLUDE
		});
	}

	/** The current user's single membership in the active org, or null if missing. */
	async findMyMembership(userId: string, organizationId: string): Promise<MembershipResponseDto> {
		const membership = await this.prisma.membership.findFirst({
			where: { userId, organizationId },
			include: MeService.MEMBERSHIP_INCLUDE
		});

		if (!membership) {
			throw new NotFoundException(MEMBERSHIP_NOT_FOUND);
		}

		return membership;
	}

	/** All orgs the current user belongs to — drives the org switcher dropdown. */
	listMyOrganizations(userId: string): Promise<MembershipResponseDto[]> {
		return this.prisma.membership.findMany({
			where: { userId },
			orderBy: { createdAt: 'asc' },
			include: MeService.MEMBERSHIP_INCLUDE
		});
	}

	/**
	 * Pin `User.currentOrganizationId` to the target. Validates the user actually has
	 * a membership there — otherwise anyone could pin themselves to any org by UUID.
	 * Returns the membership in the new org so the caller can update its UI.
	 */
	async switchActiveOrganization(userId: string, targetOrganizationId: string): Promise<MembershipResponseDto> {
		const membership = await this.findMyMembership(userId, targetOrganizationId);

		await this.prisma.user.update({
			where: { id: userId },
			data: { currentOrganizationId: targetOrganizationId }
		});

		return membership;
	}

	/**
	 * Remove a member from the active organization. Owner-only at the controller layer
	 * (`@UseGuards(OwnerGuard)`). Does NOT require entitlement — an org that's canceled or
	 * past_due should still be able to clean up its team.
	 *
	 * Business rules:
	 *  - You cannot remove yourself (would orphan the org for the sole owner).
	 *  - You cannot remove the OWNER role. Defensive: one owner per org today, and
	 *    ownership-transfer is a separate flow if multi-owner ever lands.
	 *  - Cascade-deletes the target user's `EmailAccount` rows scoped to this org so their
	 *    mailbox access doesn't outlive their membership. Prisma onDelete chain clears
	 *    `RawMessage` too.
	 *  - Re-points `User.currentOrganizationId` if the removed user had this org pinned —
	 *    moves them to their oldest remaining membership, or null if they have none.
	 *  - Best-effort `billing.syncSeatCount` after the tx commits. Pattern matches
	 *    `InvitationsService.accept`.
	 */
	async removeMember(actingUserId: string, organizationId: string, targetUserId: string): Promise<void> {
		if (actingUserId === targetUserId) {
			throw new BadRequestException(CANNOT_REMOVE_SELF);
		}

		const target = await this.prisma.membership.findFirst({
			where: { userId: targetUserId, organizationId },
			include: { user: { select: { id: true, email: true, currentOrganizationId: true } } }
		});

		if (!target) {
			throw new NotFoundException(MEMBERSHIP_NOT_FOUND);
		}

		if (target.role === MembershipRole.OWNER) {
			throw new ConflictException(CANNOT_REMOVE_OWNER);
		}

		await this.prisma.$transaction(async tx => {
			await tx.membership.delete({ where: { id: target.id } });

			// Disconnect the removed user's mailboxes scoped to this org. The cascade FK on
			// `EmailAccount.organizationId → Organization` and the `RawMessage` cascade clear
			// dependent rows. We don't call the provider's revoke endpoint — admin-driven
			// removes are different from user-driven disconnects; the tokens go inert once
			// the row is gone, and Gmail's watch (if any) expires within 7 days on its own.
			await tx.emailAccount.deleteMany({
				where: { userId: targetUserId, organizationId }
			});

			// If the removed user had this org as their active one, switch them to their
			// oldest remaining membership. If they have none, set null — they'll see the
			// "no active organization" state on next request, which is the correct UX for
			// a user who's no longer in any org.
			if (target.user.currentOrganizationId === organizationId) {
				const fallback = await tx.membership.findFirst({
					where: { userId: targetUserId, organizationId: { not: organizationId } },
					orderBy: { createdAt: 'asc' },
					select: { organizationId: true }
				});

				await tx.user.update({
					where: { id: targetUserId },
					data: { currentOrganizationId: fallback?.organizationId ?? null }
				});
			}
		});

		// Reconcile billed quantity after the tx commits. Best-effort: if Stripe is briefly
		// unreachable, the remove already happened — the next invitation accept (or a
		// webhook-driven re-sync) will fix the drift.
		await this.billing.syncSeatCount(organizationId);

		this.logService.logAction({
			action: 'membership.removed',
			message: `${target.user.email} removed from org ${organizationId}`,
			metadata: {
				organizationId,
				removedUserId: targetUserId,
				removedEmail: target.user.email,
				removedRole: target.role,
				removedBy: actingUserId
			},
			context: 'MeService'
		});
	}
}
