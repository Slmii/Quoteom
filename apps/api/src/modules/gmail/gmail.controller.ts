import { MemberWrite } from '@/common/decorators/member-write.decorator';
import { TenantMemberGuard } from '@/common/guards/tenant-member.guard';
import type { EnvSchema } from '@/config/env.schema';
import { EmailProvider } from '@/generated/prisma/enums';
import { isOrganizationEntitled } from '@/lib/billing/entitlement-check';
import { EmailConnectErrorCode, NOT_AUTHENTICATED } from '@/lib/errors';
import { EmailConnectError } from '@/lib/oauth/oauth-errors';
import { issueOAuthState, verifyOAuthState } from '@/lib/oauth/signed-state';
import { EmailAccountsService, type MailboxScope } from '@/modules/email-accounts/email-accounts.service';
import { GoogleOAuthService } from '@/modules/email-accounts/google-oauth.service';
import { GmailDisconnectResponseDto } from '@/modules/gmail/dto/disconnect.response.dto';
import { GmailMessageDto, GmailMessagesResponseDto } from '@/modules/gmail/dto/gmail-messages.response.dto';
import { GmailStatusResponseDto } from '@/modules/gmail/dto/gmail-status.response.dto';
import { GmailApiService } from '@/modules/gmail/gmail-api.service';
import { GmailWatchService } from '@/modules/gmail/gmail-watch.service';
import { GMAIL_STATE_COOKIE } from '@/modules/gmail/gmail.constants';
import { LogService } from '@/modules/logger/log.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import {
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
		// Guards run before us, so this is a defensive narrowing assertion that should
		// never fire in practice. Surface a real message rather than a bare 401 body.
		throw new UnauthorizedException(NOT_AUTHENTICATED);
	}
	return { provider: EmailProvider.GMAIL, organizationId, userId };
}

/**
 * Each user manages their own mailbox connection inside the active organization:
 *  - `connect` / `callback` / `disconnect` are writes — gated by `@MemberWrite()` so
 *    EXTERNAL collaborators can't contribute primary mailbox data, AND so unsubscribed
 *    orgs can't add new connections (the same entitlement gate as invitations).
 *  - `status` / `messages` are reads — `TenantMemberGuard` alone (EXTERNAL still blocked
 *    so they don't peek at whose mailbox is linked).
 */
@ApiTags('email')
@Controller('email/gmail')
export class GmailController {
	constructor(
		private readonly oauth: GoogleOAuthService,
		private readonly api: GmailApiService,
		private readonly accounts: EmailAccountsService,
		private readonly watch: GmailWatchService,
		private readonly config: ConfigService<EnvSchema, true>,
		private readonly prisma: PrismaService,
		private readonly logService: LogService
	) {}

	@ApiOperation({ summary: 'Start the Gmail OAuth handshake (redirects to Google).' })
	@MemberWrite()
	@Get('connect')
	async connect(@Req() request: Request, @Res() response: Response): Promise<void> {
		const { organizationId, userId } = scopeFromRequest(request);
		const webOrigin = this.config.get('WEB_ORIGIN', { infer: true });

		// Block unsubscribed orgs before sending the user off to Google. The `@MemberWrite()`
		// decorator above runs `EntitlementGuard`, but the guard skips GETs by design — so
		// this OAuth-initiate route would otherwise slip through. Same check repeats in the
		// callback as defense-in-depth (entitlement can lapse between consent + redirect).
		if (!(await isOrganizationEntitled(this.prisma, organizationId))) {
			response.redirect(`${webOrigin}/billing?error=connect_requires_subscription`);
			return;
		}

		const secret = this.config.get('AUTH_SECRET', { infer: true });
		const state = issueOAuthState({ organizationId, userId }, secret);

		// Cookie carries the same state value, signed by the same secret. Callback compares
		// both copies and rejects mismatch. httpOnly + sameSite=lax keeps it out of JS and
		// lets it survive the Google → back-to-our-callback redirect (which is a top-level
		// navigation, not a cross-site fetch).
		response.cookie(GMAIL_STATE_COOKIE, state, {
			httpOnly: true,
			sameSite: 'lax',
			secure: this.config.get('NODE_ENV', { infer: true }) === 'production',
			maxAge: 10 * 60 * 1000,
			path: '/api/email/gmail/callback'
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
		@Query('error') error: string | undefined
	): Promise<void> {
		const webOrigin = this.config.get('WEB_ORIGIN', { infer: true });

		// User clicked "Cancel" or Google returned an error — bounce back with the error
		// surface visible so the UI can render it. Always clear the state cookie either way.
		response.clearCookie(GMAIL_STATE_COOKIE, { path: '/api/email/gmail/callback' });

		if (error) {
			this.logService.logAction({
				action: 'oauth.google.error',
				message: `Google callback returned an OAuth error: ${error}`,
				metadata: { errorCode: error },
				level: 'warn',
				context: 'GmailController'
			});
			response.redirect(`${webOrigin}/settings/email?error=${EmailConnectErrorCode.ProviderRejected}`);
			return;
		}

		try {
			if (!code || !state) {
				throw new EmailConnectError(EmailConnectErrorCode.CodeMissing);
			}

			const cookieState = readCookie(request, GMAIL_STATE_COOKIE);
			if (!cookieState || cookieState !== state) {
				throw new EmailConnectError(EmailConnectErrorCode.StateMismatch);
			}

			const secret = this.config.get('AUTH_SECRET', { infer: true });
			const payload = verifyOAuthState(state, secret);
			if (!payload) {
				throw new EmailConnectError(EmailConnectErrorCode.StateMismatch);
			}

			// Cross-check the signed payload against the live session. The guard already
			// confirmed this user belongs to `request.organizationId`; we additionally
			// require the connect-initiation org/user to match — defense against a stale
			// cookie surviving a logout + login as someone else.
			const { organizationId, userId } = scopeFromRequest(request);
			if (payload.organizationId !== organizationId || payload.userId !== userId) {
				throw new EmailConnectError(EmailConnectErrorCode.StateMismatch);
			}

			// Defense-in-depth: entitlement can lapse between `connect` and `callback` (the user
			// could cancel their subscription in another tab mid-flow). Stop before we exchange
			// code → tokens, so we never persist credentials for an unbilled org.
			if (!(await isOrganizationEntitled(this.prisma, organizationId))) {
				response.redirect(`${webOrigin}/billing?error=connect_requires_subscription`);
				return;
			}

			const tokens = await this.oauth.exchangeCode(code);
			const userInfo = await this.oauth.fetchUserInfo(tokens.accessToken);

			await this.accounts.upsertEmailAccount({
				provider: EmailProvider.GMAIL,
				organizationId,
				userId,
				providerAccountId: userInfo.sub,
				email: userInfo.email,
				tokens
			});

			response.redirect(`${webOrigin}/settings/email?connected=1`);
		} catch (err) {
			const errorCode = err instanceof EmailConnectError ? err.code : EmailConnectErrorCode.Unknown;

			if (!(err instanceof EmailConnectError)) {
				this.logService.logAction({
					action: 'oauth.google.callback_unexpected_error',
					message: `Google callback failed unexpectedly: ${err instanceof Error ? err.message : 'unknown'}`,
					metadata: { errorCode },
					level: 'error',
					stack: err instanceof Error ? err.stack : undefined,
					context: 'GmailController'
				});
			}

			response.redirect(`${webOrigin}/settings/email?error=${errorCode}`);
		}
	}

	@ApiOperation({ summary: 'Is THIS user’s Gmail mailbox connected for the active org?' })
	@ApiOkResponse({ type: GmailStatusResponseDto })
	@UseGuards(TenantMemberGuard)
	@Get('status')
	async status(@Req() request: Request): Promise<GmailStatusResponseDto> {
		const scope = scopeFromRequest(request);
		const account = await this.accounts.findEmailAccount(scope);
		return {
			connected: account !== null,
			email: account?.email ?? null,
			connectedAt: account?.createdAt.toISOString() ?? null
		};
	}

	@ApiOperation({
		summary: `Smoke endpoint: the ${RECENT_MESSAGE_LIMIT} most recent message IDs from THIS user’s connected mailbox.`
	})
	@ApiOkResponse({ type: GmailMessagesResponseDto })
	@UseGuards(TenantMemberGuard)
	@Get('messages')
	async messages(@Req() request: Request): Promise<GmailMessagesResponseDto> {
		const scope = scopeFromRequest(request);

		// `withFreshAccessToken` retries once on Gmail 401 — covers the case where the
		// user revoked our app at myaccount.google.com while the cached access token still
		// looked fresh on our side. If the retry's forced refresh hits `invalid_grant`,
		// the EmailAccount row is deleted and a 404 propagates (web layer → empty list).
		const messages = await this.accounts.withFreshAccessToken(scope, async accessToken => {
			const stubs = await this.api.listRecentInboxMessages(accessToken, RECENT_MESSAGE_LIMIT);

			// Fetch metadata for each in parallel. Gmail's per-user QPS limits are generous
			// (~250 quota units / user / sec; messages.get costs 5). Ten parallel calls is fine.
			const metadata = await Promise.all(stubs.map(stub => this.api.getMessageMetadata(accessToken, stub.id)));

			return metadata.map<GmailMessageDto>(m => ({
				id: m.id,
				threadId: m.threadId,
				// `internalDate` is unix ms as string from Gmail; render as ISO for the UI.
				internalDate: new Date(Number(m.internalDate)).toISOString(),
				snippet: m.snippet,
				subject: m.subject,
				from: m.from
			}));
		});

		return { messages };
	}

	@ApiOperation({ summary: 'Revoke THIS user’s Gmail token at Google + clear the local row.' })
	@ApiOkResponse({ type: GmailDisconnectResponseDto })
	@MemberWrite()
	@HttpCode(HttpStatus.OK)
	@Post('disconnect')
	async disconnect(@Req() request: Request): Promise<GmailDisconnectResponseDto> {
		const scope = scopeFromRequest(request);
		// Stop the Pub/Sub watch at Google BEFORE the row is deleted — once `disconnectEmail
		// Account` revokes the refresh token + drops the row, we lose the ID needed for the
		// stop call. `stopWatchForScope` is best-effort and swallows failures so a transient
		// Gmail hiccup never blocks disconnect.
		await this.watch.stopWatchForScope(scope);
		await this.accounts.disconnectEmailAccount(scope);
		return { ok: true };
	}
}
