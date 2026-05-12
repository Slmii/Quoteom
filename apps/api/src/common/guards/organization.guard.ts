import { AuthGuard } from '@/common/guards/auth.guard';
import { NO_ACTIVE_ORGANIZATION } from '@/lib/errors';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Authenticates the request AND requires an active organization on the user.
 * Use on any route that operates within a tenant boundary — which is most routes.
 *
 * Attaches `request.organizationId` for downstream services to scope queries by.
 * Extends AuthGuard so the auth check runs exactly once per request.
 *
 * Reads `User.currentOrganizationId` from the DB on every call (not from the JWT) so
 * that switching the active organization takes effect immediately — no JWT refresh
 * dance. The DB row is the source of truth; the JWT only carries `userId`.
 */
@Injectable()
export class OrganizationGuard extends AuthGuard {
	constructor(protected readonly prisma: PrismaService) {
		super();
	}

	override async canActivate(context: ExecutionContext): Promise<boolean> {
		await super.canActivate(context);

		const request = context.switchToHttp().getRequest<Request>();
		const userId = request.authSession?.user?.id;
		if (!userId) {
			throw new ForbiddenException(NO_ACTIVE_ORGANIZATION);
		}

		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: { currentOrganizationId: true }
		});

		if (!user?.currentOrganizationId) {
			throw new ForbiddenException(NO_ACTIVE_ORGANIZATION);
		}

		request.organizationId = user.currentOrganizationId;
		return true;
	}
}
