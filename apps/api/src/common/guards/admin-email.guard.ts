import { AuthGuard } from '@/common/guards/auth.guard';
import type { EnvSchema } from '@/config/env.schema';
import { NOT_AUTHENTICATED } from '@/lib/errors';
import { ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/**
 * Gates admin/dev endpoints (e.g. /api/admin/ai-usage) behind an email allowlist set via
 * the `ADMIN_EMAILS` env var (comma-separated, case-insensitive). Inherits from
 * `AuthGuard` so the auth check runs exactly once per request (same pattern as
 * `OrganizationGuard`); a non-authenticated request is rejected before the allowlist
 * check is even read.
 *
 * Empty/unset `ADMIN_EMAILS` → 403 for everyone (the safe default; admins are explicitly
 * opted in, never implicit).
 */
@Injectable()
export class AdminEmailGuard extends AuthGuard {
	constructor(private readonly config: ConfigService<EnvSchema, true>) {
		super();
	}

	override async canActivate(context: ExecutionContext): Promise<boolean> {
		await super.canActivate(context);

		const request = context.switchToHttp().getRequest<Request>();
		const email = request.authSession?.user?.email?.toLowerCase();
		if (!email) {
			throw new UnauthorizedException(NOT_AUTHENTICATED);
		}

		const allowlist = this.parseAllowlist(this.config.get('ADMIN_EMAILS', { infer: true }));
		if (!allowlist.has(email)) {
			throw new ForbiddenException();
		}

		return true;
	}

	private parseAllowlist(raw: string | undefined): Set<string> {
		if (!raw) {
			return new Set();
		}

		return new Set(
			raw
				.split(',')
				.map(s => s.trim().toLowerCase())
				.filter(s => s.length > 0)
		);
	}
}
