import type { EnvSchema } from '@/config/env.schema';
import { EmailProvider } from '@/generated/prisma/enums';
import { PubSubJWTVerificationError, verifyPubSubJWT } from '@/lib/oauth/pubsub-jwt-verifier';
import { inngest } from '@/modules/inngest/inngest.client';
import { InngestEvents } from '@/modules/inngest/inngest.constants';
import { LogService } from '@/modules/logger/log.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import {
	BadRequestException,
	Controller,
	Headers,
	HttpCode,
	HttpStatus,
	Post,
	Req,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';

interface PubSubPushBody {
	message: {
		data: string;
		messageId: string;
		publishTime: string;
		attributes?: Record<string, string>;
	};
	subscription: string;
}

interface GmailNotificationPayload {
	emailAddress: string;
	historyId: string | number;
}

/**
 * W3.5 — receives Gmail push notifications via Google Cloud Pub/Sub.
 *
 * Pub/Sub push delivery shape:
 *   POST /api/email/gmail/webhook
 *   Authorization: Bearer <Google-signed JWT>
 *   Content-Type: application/json
 *   Body: { message: { data: <base64 JSON>, ... }, subscription: ... }
 *
 * Auth is the JWT, not a session cookie. We verify it via `verifyPubSubJWT` (RS256 + JWKS
 * + iss/aud/exp/service-account-email checks). On success: decode the base64 message data
 * into `{ emailAddress, historyId }`, look up the local `EmailAccount` by email + Gmail
 * provider, and fire the `gmail/history.changed` Inngest event so the delta-sync function
 * picks it up asynchronously.
 *
 * Status code conventions follow Pub/Sub's contract:
 *   - 204 No Content → message accepted (Pub/Sub stops retrying)
 *   - 401 → auth failed → Pub/Sub retries with backoff
 *   - 503 → not configured (dev) → Pub/Sub backs off but doesn't drop the message
 * We deliberately return 204 even when the lookup misses (mailbox disconnected since the
 * watch was registered) — re-trying won't help, and a 4xx would trigger a retry storm.
 *
 * @SkipThrottle — Pub/Sub retries aggressively on transient failures; rate-limiting it
 * just cascades into more retries. The JWT is the auth.
 */
@ApiExcludeController()
@Controller('email/gmail/webhook')
export class GmailWebhookController {
	constructor(
		private readonly config: ConfigService<EnvSchema, true>,
		private readonly prisma: PrismaService,
		private readonly logService: LogService
	) {}

	@SkipThrottle()
	@HttpCode(HttpStatus.NO_CONTENT)
	@Post()
	async receive(@Req() request: Request, @Headers('authorization') authorization: string | undefined): Promise<void> {
		const audience = this.config.get('GOOGLE_PUBSUB_AUDIENCE', { infer: true });
		const serviceAccount = this.config.get('GOOGLE_PUBSUB_SERVICE_ACCOUNT', { infer: true });

		// Belt-and-suspenders: refuse to accept pushes if the verifier isn't fully configured.
		// 503 keeps Pub/Sub retrying with backoff instead of dropping the message — once the
		// env is filled in, the next retry succeeds.
		if (!audience || !serviceAccount) {
			this.logService.logAction({
				action: 'gmail.webhook.not_configured',
				message: 'Gmail webhook hit but GOOGLE_PUBSUB_AUDIENCE / GOOGLE_PUBSUB_SERVICE_ACCOUNT missing',
				level: 'error',
				context: 'GmailWebhookController'
			});
			throw new ServiceUnavailableException('Gmail webhook not configured');
		}

		const token = parseBearerToken(authorization);
		if (!token) {
			throw new UnauthorizedException('Missing or malformed Authorization header');
		}

		try {
			await verifyPubSubJWT(token, audience, serviceAccount);
		} catch (error) {
			if (error instanceof PubSubJWTVerificationError) {
				this.logService.logAction({
					action: 'gmail.webhook.jwt_invalid',
					message: `Gmail webhook JWT verification failed: ${error.message}`,
					metadata: { reason: error.message },
					level: 'warn',
					context: 'GmailWebhookController'
				});
				throw new UnauthorizedException('Invalid Pub/Sub JWT');
			}
			throw error;
		}

		const body = request.body as PubSubPushBody | undefined;
		if (!body?.message?.data) {
			throw new BadRequestException('Pub/Sub push body must include message.data');
		}

		const payload = decodeNotification(body.message.data);
		if (!payload) {
			throw new BadRequestException('Pub/Sub message.data is not valid base64 JSON');
		}

		// Fan-out: the same Gmail mailbox can be connected to multiple organizations
		// (the EmailAccount @@unique constraint is `(organizationId, provider,
		// providerAccountId)` — not on email alone). Each org gets its own delta-sync run
		// so a push to a shared mailbox doesn't silently drop sync for every org except
		// the first one returned.
		const accounts = await this.prisma.emailAccount.findMany({
			where: { provider: EmailProvider.GMAIL, email: payload.emailAddress },
			select: { id: true, organizationId: true, userId: true }
		});

		// No matching accounts — typical "watch fired after disconnect" case. Acknowledge
		// with 204 so Pub/Sub stops retrying; the watch will expire on its own within ~7d.
		if (accounts.length === 0) {
			this.logService.logAction({
				action: 'gmail.webhook.unknown_mailbox',
				message: `Gmail push for unknown mailbox ${payload.emailAddress} — acknowledging + skipping`,
				metadata: { emailAddress: payload.emailAddress, messageId: body.message.messageId },
				level: 'warn',
				context: 'GmailWebhookController'
			});
			return;
		}

		// Enqueue one delta-sync per matched account. Failures on individual sends are
		// logged but don't abort the batch — losing one org's sync is better than losing
		// all of them.
		for (const account of accounts) {
			try {
				await inngest.send({
					name: InngestEvents.GmailHistoryChanged,
					data: { emailAccountId: account.id, organizationId: account.organizationId }
				});
				this.logService.logAction({
					action: 'gmail.webhook.received',
					message: `Gmail push received for ${payload.emailAddress} — delta sync enqueued`,
					metadata: {
						emailAccountId: account.id,
						organizationId: account.organizationId,
						emailAddress: payload.emailAddress,
						historyId: String(payload.historyId),
						messageId: body.message.messageId
					},
					context: 'GmailWebhookController'
				});
			} catch (error) {
				// Best-effort — if Inngest is temporarily unreachable, log + continue with
				// the next account. Pub/Sub retries on 5xx; we 204 to avoid retry spam.
				this.logService.logAction({
					action: 'gmail.webhook.enqueue_failed',
					message: `Failed to enqueue delta sync for ${payload.emailAddress}: ${error instanceof Error ? error.message : 'unknown'}`,
					metadata: {
						emailAccountId: account.id,
						emailAddress: payload.emailAddress,
						messageId: body.message.messageId
					},
					level: 'error',
					stack: error instanceof Error ? error.stack : undefined,
					context: 'GmailWebhookController'
				});
			}
		}
	}
}

function parseBearerToken(header: string | undefined): string | null {
	if (!header) {
		return null;
	}
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match ? (match[1]?.trim() ?? null) : null;
}

function decodeNotification(data: string): GmailNotificationPayload | null {
	try {
		const decoded = Buffer.from(data, 'base64').toString('utf8');
		const parsed = JSON.parse(decoded) as GmailNotificationPayload;
		if (
			typeof parsed.emailAddress !== 'string' ||
			(typeof parsed.historyId !== 'string' && typeof parsed.historyId !== 'number')
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}
