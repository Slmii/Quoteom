import { NOT_AUTHENTICATED } from '@/lib/errors';
import { authConfig } from '@/modules/auth/auth.config';
import { logContext } from '@/modules/logger/log-context';
import { getSession } from '@auth/express';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<Request>();

		// Skip re-fetching the session if a previously-composed guard already attached one.
		const session = request.authSession ?? (await getSession(request, authConfig));

		if (!session?.user) {
			throw new UnauthorizedException(NOT_AUTHENTICATED);
		}

		request.authSession = session;

		// Push the resolved user onto the request-scoped log context so any subsequent log
		// (warn/error/logAction) in this request automatically carries the actor's userId.
		// No-op if the request-context middleware didn't wrap this request (e.g. tests).
		if (session.user.id) {
			logContext.set({ userId: session.user.id });
		}

		return true;
	}
}
