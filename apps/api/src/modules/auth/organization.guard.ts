import { NO_ACTIVE_ORGANIZATION } from '@/lib/errors';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Authenticates the request AND requires an active organization on the session.
 * Use on any route that operates within a tenant boundary — which is most routes.
 *
 * Attaches `request.organizationId` for downstream services to scope queries by.
 * Extends AuthGuard so the auth check runs exactly once per request.
 */
@Injectable()
export class OrganizationGuard extends AuthGuard {
	override async canActivate(context: ExecutionContext): Promise<boolean> {
		await super.canActivate(context);

		const request = context.switchToHttp().getRequest<Request>();
		const organizationId = request.authSession?.user?.organizationId;

		if (!organizationId) {
			throw new ForbiddenException(NO_ACTIVE_ORGANIZATION);
		}

		request.organizationId = organizationId;
		return true;
	}
}
