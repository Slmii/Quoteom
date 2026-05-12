import { MembershipRole } from '@/generated/prisma/client';
import { OWNER_ROLE_REQUIRED } from '@/lib/errors';
import { OrganizationGuard } from '@/modules/auth/organization.guard';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Authenticates + requires the current user to hold the OWNER role on the active org.
 *
 * Use on routes that should only be reachable by the org's owner — billing management,
 * destructive admin actions, ownership transfer, etc. For tenant-scoped reads/writes that
 * any member can perform, use `OrganizationGuard` instead.
 *
 * Composes with `TrialGateGuard` if needed (write entitlement + role). They check different
 * dimensions so order doesn't matter.
 */
@Injectable()
export class OwnerGuard extends OrganizationGuard {
	constructor(private readonly prisma: PrismaService) {
		super();
	}

	override async canActivate(context: ExecutionContext): Promise<boolean> {
		await super.canActivate(context);

		const request = context.switchToHttp().getRequest<Request>();
		const userId = request.authSession?.user?.id;
		const organizationId = request.organizationId;

		// `super.canActivate` already guarantees both — defensive narrowing.
		if (!userId || !organizationId) {
			throw new ForbiddenException(OWNER_ROLE_REQUIRED);
		}

		const membership = await this.prisma.membership.findFirst({
			where: { userId, organizationId, role: MembershipRole.OWNER },
			select: { id: true }
		});

		if (!membership) {
			throw new ForbiddenException(OWNER_ROLE_REQUIRED);
		}

		return true;
	}
}
