import { authConfig } from '@/modules/auth/auth.config';
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
			throw new UnauthorizedException('Not authenticated');
		}

		request.authSession = session;
		return true;
	}
}
