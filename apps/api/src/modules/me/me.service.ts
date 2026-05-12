import { MEMBERSHIP_NOT_FOUND } from '@/lib/errors';
import { MembershipResponseDto } from '@/modules/me/dto/membership.response.dto';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { Injectable, NotFoundException } from '@nestjs/common';

/**
 * Reads + writes scoped to the current user. Controller stays thin — orchestrates
 * `request.organizationId` (set by OrganizationGuard) and `request.authSession.user.id`
 * into these methods and returns the result.
 */
@Injectable()
export class MeService {
	constructor(private readonly prisma: PrismaService) {}

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
}
