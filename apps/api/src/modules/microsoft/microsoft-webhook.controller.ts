import { EmailProvider } from '@/generated/prisma/enums';
import { inngest } from '@/modules/inngest/inngest.client';
import { InngestEvents } from '@/modules/inngest/inngest.constants';
import { LogService } from '@/modules/logger/log.service';
import { MicrosoftSubscriptionService } from '@/modules/microsoft/microsoft-subscription.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { BadRequestException, Controller, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

interface GraphChangeNotification {
	subscriptionId: string;
	subscriptionExpirationDateTime?: string;
	clientState?: string;
	changeType: string;
	resource?: string;
	resourceData?: { id?: string };
	tenantId?: string;
}

interface GraphNotificationBody {
	value?: GraphChangeNotification[];
}

/**
 * W3.6 — receives Microsoft Graph push notifications.
 *
 * Graph push delivery shape:
 *   POST /api/email/microsoft/webhook
 *   Content-Type: application/json
 *   Body: { value: [{ subscriptionId, clientState, changeType, resource, resourceData, ... }] }
 *
 * Two responsibilities:
 *  1. **Validation handshake.** Graph calls our notificationUrl with `?validationToken=<random>`
 *     during subscription creation AND occasionally during renewals to confirm we still own
 *     the endpoint. The response must be the raw plaintext token, content-type `text/plain`,
 *     HTTP 200, within 5 seconds. Our controller short-circuits on the query param BEFORE
 *     any other logic so subscription creation can complete.
 *
 *  2. **Change notifications.** Graph batches multiple notifications per POST. Each item
 *     includes `clientState` — the per-subscription shared secret we generated and stored
 *     encrypted at create-time. We look up the local EmailAccount by `subscriptionId`,
 *     verify clientState equality, then fire `microsoft/delta.changed` so the delta-sync
 *     Inngest function picks it up. Per-mailbox debounce on the function coalesces bursts.
 *
 * Status code conventions follow Graph's contract:
 *   - 200 (validation) → with plaintext token body
 *   - 202 (notifications) → accepted; Graph stops retrying
 *   - 400 → malformed body → Graph retries with backoff
 *   - 4xx auth-style failures → Graph retries; eventually disables the subscription
 *
 * As with Gmail's webhook we return 202 even when the lookup misses (mailbox disconnected
 * after the subscription was registered) — re-trying won't help.
 *
 * `@SkipThrottle` — Graph retries aggressively on transient failures; rate-limiting just
 * cascades into more retries. The `clientState` shared secret is the auth.
 */
@ApiExcludeController()
@Controller('email/microsoft/webhook')
export class MicrosoftWebhookController {
	constructor(
		private readonly prisma: PrismaService,
		private readonly subscriptions: MicrosoftSubscriptionService,
		private readonly logService: LogService
	) {}

	/**
	 * Single handler for both the validation handshake AND change notifications. Graph
	 * uses the same URL + verb for both — distinguishes them via the `validationToken`
	 * query string.
	 *
	 * Validation MUST be handled first + return synchronously within 5 s, otherwise Graph
	 * fails the subscription. NEVER touch the DB or Inngest on that path — keep it
	 * minimal so even a degraded service can complete the handshake.
	 */
	@SkipThrottle()
	@Post()
	async receive(
		@Req() request: Request,
		@Res() response: Response,
		@Query('validationToken') validationToken: string | undefined
	): Promise<void> {
		// 1) Validation handshake — must short-circuit BEFORE anything else, and respond
		//    with the raw token as `text/plain` (Graph rejects JSON-stringified responses
		//    like `"tok-abc"` with the quote marks). Using `res.type(...).send(...)`
		//    bypasses NestJS's default JSON serializer.
		if (typeof validationToken === 'string' && validationToken.length > 0) {
			this.logService.logAction({
				action: 'microsoft.webhook.validation',
				message: 'Microsoft Graph validation handshake — echoing token',
				metadata: { tokenLength: validationToken.length },
				context: 'MicrosoftWebhookController'
			});
			response.type('text/plain').status(200).send(validationToken);
			return;
		}

		// 2) Change notification path.
		const body = request.body as GraphNotificationBody | undefined;
		if (!body || !Array.isArray(body.value)) {
			throw new BadRequestException('Graph notification body must include a `value` array');
		}

		// Group by subscriptionId so we look up each EmailAccount once even when a batch
		// contains many notifications for the same mailbox.
		const bySubscription = new Map<string, GraphChangeNotification[]>();
		for (const note of body.value) {
			if (!note?.subscriptionId) {
				continue;
			}
			const list = bySubscription.get(note.subscriptionId) ?? [];
			list.push(note);
			bySubscription.set(note.subscriptionId, list);
		}

		// Process subscriptions sequentially. Graph batches are small (typically ≤10) and
		// parallelizing buys us little while making error reporting harder to read.
		const enqueuedAccounts = new Map<string, { organizationId: string }>();
		for (const [subscriptionId, notes] of bySubscription) {
			const account = await this.prisma.emailAccount.findFirst({
				where: { provider: EmailProvider.MICROSOFT, subscriptionId },
				select: { id: true, organizationId: true, email: true }
			});

			if (!account) {
				// Unknown subscription — typical "subscription fired after disconnect" case.
				// 202 acknowledges with no enqueue; Graph stops retrying.
				this.logService.logAction({
					action: 'microsoft.webhook.unknown_subscription',
					message: `Microsoft push for unknown subscription ${subscriptionId} — acknowledging + skipping`,
					metadata: { subscriptionId, notificationCount: notes.length },
					level: 'warn',
					context: 'MicrosoftWebhookController'
				});
				continue;
			}

			// Verify clientState on EVERY notification in the batch. A mixed batch (some
			// valid, some forged) is exceedingly unlikely but we'd rather drop the whole
			// batch than let one through.
			const expectedClientState = await this.subscriptions.getClientStateForAccount(account.id);
			if (!expectedClientState) {
				this.logService.logAction({
					action: 'microsoft.webhook.missing_client_state',
					message: `EmailAccount ${account.id} matched subscription ${subscriptionId} but has no stored clientState — refusing to act`,
					metadata: { emailAccountId: account.id, subscriptionId },
					level: 'error',
					context: 'MicrosoftWebhookController'
				});
				continue;
			}

			const allMatch = notes.every(n => safeCompare(n.clientState ?? '', expectedClientState));
			if (!allMatch) {
				this.logService.logAction({
					action: 'microsoft.webhook.client_state_mismatch',
					message: `clientState mismatch for subscription ${subscriptionId} — possible forged push, dropping batch`,
					metadata: { emailAccountId: account.id, subscriptionId, notificationCount: notes.length },
					level: 'error',
					context: 'MicrosoftWebhookController'
				});
				continue;
			}

			enqueuedAccounts.set(account.id, { organizationId: account.organizationId });

			this.logService.logAction({
				action: 'microsoft.webhook.received',
				message: `Microsoft push received for ${account.email} (${notes.length} notification${notes.length === 1 ? '' : 's'})`,
				metadata: {
					emailAccountId: account.id,
					organizationId: account.organizationId,
					subscriptionId,
					notificationCount: notes.length
				},
				context: 'MicrosoftWebhookController'
			});
		}

		// Fire one Inngest event per unique account in the batch — the function's
		// per-mailbox debounce coalesces if multiple POSTs land in quick succession.
		for (const [emailAccountId, { organizationId }] of enqueuedAccounts) {
			try {
				await inngest.send({
					name: InngestEvents.MicrosoftDeltaChanged,
					data: { emailAccountId, organizationId }
				});
			} catch (error) {
				this.logService.logAction({
					action: 'microsoft.webhook.enqueue_failed',
					message: `Failed to enqueue Microsoft delta sync for ${emailAccountId}: ${error instanceof Error ? error.message : 'unknown'}`,
					metadata: { emailAccountId, organizationId },
					level: 'error',
					stack: error instanceof Error ? error.stack : undefined,
					context: 'MicrosoftWebhookController'
				});
				// Continue draining the rest of the batch — one Inngest failure shouldn't
				// drop the other mailbox events.
			}
		}

		// Graph accepts any 2xx; 202 = "received + processing async" matches reality
		// (delta-sync happens via Inngest, not inline). Empty body — Graph ignores it.
		response.status(202).send();
	}
}

/**
 * Constant-time string comparison. Standard library `crypto.timingSafeEqual` requires
 * equal-length buffers, so we pad. Used to compare the per-subscription shared secret
 * — not security-critical since the attacker would need to guess the random 32-byte
 * hex anyway, but defense-in-depth.
 */
function safeCompare(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
