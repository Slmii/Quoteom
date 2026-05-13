import { MemberWrite } from '@/common/decorators/member-write.decorator';
import { TenantMemberGuard } from '@/common/guards/tenant-member.guard';
import type { EnvSchema } from '@/config/env.schema';
import { EmailProvider } from '@/generated/prisma/enums';
import {
	MICROSOFT_ADMIN_CONSENT_ERROR_CODE_REGEX,
	MICROSOFT_ADMIN_CONSENT_REQUIRED,
	OAUTH_CODE_MISSING,
	OAUTH_STATE_INVALID
} from '@/lib/errors';
import { issueOAuthState, verifyOAuthState } from '@/lib/oauth/signed-state';
import { EmailAccountsService, type MailboxScope } from '@/modules/email-accounts/email-accounts.service';
import { MicrosoftOAuthService } from '@/modules/email-accounts/microsoft-oauth.service';
import { LogService } from '@/modules/logger/log.service';
import { MicrosoftDisconnectResponseDto } from '@/modules/microsoft/dto/microsoft-disconnect.response.dto';
import {
	MicrosoftMessageDto,
	MicrosoftMessagesResponseDto
} from '@/modules/microsoft/dto/microsoft-messages.response.dto';
import { MicrosoftStatusResponseDto } from '@/modules/microsoft/dto/microsoft-status.response.dto';
import { MicrosoftGraphApiService } from '@/modules/microsoft/microsoft-graph-api.service';
import { MICROSOFT_STATE_COOKIE } from '@/modules/microsoft/microsoft.constants';
import {
	BadRequestException,
	Controller,
	Get,
	HttpCode,
	HttpStatus,
	Post,
	Query,
	Req,
	Res,
	UnauthorizedException,
	UseGuards
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

const RECENT_MESSAGE_LIMIT = 10;

/** Minimal cookie parser — Express 5 doesn't include `cookie-parser` by default. */
function readCookie(request: Request, name: string): string | null {
	const header = request.headers.cookie;
	if (!header) {
		return null;
	}
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq < 0) {
			continue;
		}

		const key = part.slice(0, eq).trim();
		if (key === name) {
			return decodeURIComponent(part.slice(eq + 1).trim());
		}
	}
	return null;
}

function scopeFromRequest(request: Request): MailboxScope {
	const userId = request.authSession?.user?.id;
	const organizationId = request.organizationId;
	if (!userId || !organizationId) {
		throw new UnauthorizedException();
	}
	return { provider: EmailProvider.MICROSOFT, organizationId, userId };
}

/**
 * Microsoft Graph inbox-connect — mirrors `GmailController` shape with provider-specific
 * routing. Lives under `/api/email/microsoft/*`.
 *
 * Per-user mailboxes, OWNER + MEMBER (no EXTERNAL), entitlement-gated writes — same rules
 * as Gmail. The actual handshake differs (Entra endpoints, different scopes, no programmatic
 * revoke) but those details are encapsulated in `MicrosoftOAuthService`.
 */
@ApiTags('email')
@Controller('email/microsoft')
export class MicrosoftController {
	constructor(
		private readonly oauth: MicrosoftOAuthService,
		private readonly api: MicrosoftGraphApiService,
		private readonly accounts: EmailAccountsService,
		private readonly config: ConfigService<EnvSchema, true>,
		private readonly logService: LogService
	) {}

	@ApiOperation({ summary: 'Start the Microsoft OAuth handshake (redirects to Entra).' })
	@MemberWrite()
	@Get('connect')
	connect(@Req() request: Request, @Res() response: Response): void {
		const { organizationId, userId } = scopeFromRequest(request);

		const secret = this.config.get('AUTH_SECRET', { infer: true });
		const state = issueOAuthState({ organizationId, userId }, secret);

		response.cookie(MICROSOFT_STATE_COOKIE, state, {
			httpOnly: true,
			sameSite: 'lax',
			secure: this.config.get('NODE_ENV', { infer: true }) === 'production',
			maxAge: 10 * 60 * 1000,
			path: '/api/email/microsoft/callback'
		});

		const authorizeUrl = this.oauth.buildAuthorizeUrl(state);
		response.redirect(authorizeUrl);
	}

	@ApiOperation({
		summary: 'OAuth callback — exchanges the code, persists encrypted tokens, redirects to /settings/email.'
	})
	@MemberWrite()
	@Get('callback')
	async callback(
		@Req() request: Request,
		@Res() response: Response,
		@Query('code') code: string | undefined,
		@Query('state') state: string | undefined,
		@Query('error') error: string | undefined,
		@Query('error_description') errorDescription: string | undefined
	): Promise<void> {
		const webOrigin = this.config.get('WEB_ORIGIN', { infer: true });
		response.clearCookie(MICROSOFT_STATE_COOKIE, { path: '/api/email/microsoft/callback' });

		if (error) {
			// Admin-consent required: the user is in a work tenant where the admin has
			// disabled user-level consent for Mail.* scopes. Surface a structured code so
			// the UI can render the "send your admin this link" CTA instead of the generic
			// error Alert. Pass the admin-consent URL through so the web layer doesn't
			// need to know about Entra endpoints.
			if (errorDescription && MICROSOFT_ADMIN_CONSENT_ERROR_CODE_REGEX.test(errorDescription)) {
				const adminConsentUrl = this.oauth.buildAdminConsentUrl();
				const params = new URLSearchParams({
					error: MICROSOFT_ADMIN_CONSENT_REQUIRED,
					adminConsentUrl
				});
				this.logService.logAction({
					action: 'oauth.microsoft.admin_consent_required',
					message: 'Microsoft callback returned an admin-consent-required error code',
					metadata: {
						errorCode: error,
						// Truncated — error_description from Entra can be 500+ chars; the
						// first 200 keep the AADSTSxxxxx prefix + the useful prose without
						// flooding the Log table.
						errorDescription: errorDescription.slice(0, 200),
						adminConsentUrlGenerated: true
					},
					level: 'warn',
					context: 'MicrosoftController'
				});
				response.redirect(`${webOrigin}/settings/email?${params.toString()}`);
				return;
			}

			this.logService.logAction({
				action: 'oauth.microsoft.error',
				message: `Microsoft callback returned an OAuth error: ${error}`,
				metadata: {
					errorCode: error,
					errorDescription: errorDescription ? errorDescription.slice(0, 200) : null
				},
				level: 'warn',
				context: 'MicrosoftController'
			});
			response.redirect(`${webOrigin}/settings/email?error=${encodeURIComponent(error)}`);
			return;
		}

		if (!code || !state) {
			throw new BadRequestException(OAUTH_CODE_MISSING);
		}

		const cookieState = readCookie(request, MICROSOFT_STATE_COOKIE);
		if (!cookieState || cookieState !== state) {
			throw new BadRequestException(OAUTH_STATE_INVALID);
		}

		const secret = this.config.get('AUTH_SECRET', { infer: true });
		const payload = verifyOAuthState(state, secret);
		if (!payload) {
			throw new BadRequestException(OAUTH_STATE_INVALID);
		}

		const { organizationId, userId } = scopeFromRequest(request);
		if (payload.organizationId !== organizationId || payload.userId !== userId) {
			throw new BadRequestException(OAUTH_STATE_INVALID);
		}

		const tokens = await this.oauth.exchangeCode(code);
		const profile = await this.oauth.fetchUserInfo(tokens.accessToken);

		// Microsoft profiles don't always have `mail` populated (personal accounts that
		// haven't set up email forwarding return null). Fall back to `userPrincipalName`,
		// which is email-shaped for both work and consumer Microsoft accounts.
		const email = profile.mail ?? profile.userPrincipalName;

		await this.accounts.upsertEmailAccount({
			provider: EmailProvider.MICROSOFT,
			organizationId,
			userId,
			providerAccountId: profile.id,
			email,
			tokens
		});

		response.redirect(`${webOrigin}/settings/email?connected=1`);
	}

	@ApiOperation({ summary: 'Is THIS user’s Microsoft mailbox connected for the active org?' })
	@ApiOkResponse({ type: MicrosoftStatusResponseDto })
	@UseGuards(TenantMemberGuard)
	@Get('status')
	async status(@Req() request: Request): Promise<MicrosoftStatusResponseDto> {
		const scope = scopeFromRequest(request);
		const account = await this.accounts.findEmailAccount(scope);
		return {
			connected: account !== null,
			email: account?.email ?? null,
			connectedAt: account?.createdAt.toISOString() ?? null
		};
	}

	@ApiOperation({
		summary: `Smoke endpoint: the ${RECENT_MESSAGE_LIMIT} most recent inbox messages from THIS user’s connected mailbox.`
	})
	@ApiOkResponse({ type: MicrosoftMessagesResponseDto })
	@UseGuards(TenantMemberGuard)
	@Get('messages')
	async messages(@Req() request: Request): Promise<MicrosoftMessagesResponseDto> {
		const scope = scopeFromRequest(request);

		const messages = await this.accounts.withFreshAccessToken(scope, async accessToken => {
			const stubs = await this.api.listRecentInboxMessages(accessToken, RECENT_MESSAGE_LIMIT);
			return stubs.map<MicrosoftMessageDto>(m => ({
				id: m.id,
				conversationId: m.conversationId,
				receivedDateTime: m.receivedDateTime,
				bodyPreview: m.bodyPreview,
				subject: m.subject,
				fromEmail: m.from?.address ?? null,
				fromName: m.from?.name ?? null
			}));
		});

		return { messages };
	}

	@ApiOperation({ summary: 'Disconnect THIS user’s Microsoft mailbox.' })
	@ApiOkResponse({ type: MicrosoftDisconnectResponseDto })
	@MemberWrite()
	@HttpCode(HttpStatus.OK)
	@Post('disconnect')
	async disconnect(@Req() request: Request): Promise<MicrosoftDisconnectResponseDto> {
		const scope = scopeFromRequest(request);
		await this.accounts.disconnectEmailAccount(scope);
		return { ok: true };
	}
}
