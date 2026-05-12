import type { EnvSchema } from '@/config/env.schema';
import {
	STRIPE_RAW_BODY_MISSING,
	STRIPE_SIGNATURE_HEADER_MISSING,
	STRIPE_SIGNATURE_INVALID,
	STRIPE_WEBHOOK_SECRET_MISSING
} from '@/lib/errors';
import { OrganizationGuard } from '@/modules/auth/organization.guard';
import { OwnerGuard } from '@/modules/auth/owner.guard';
import { BillingService } from '@/modules/billing/billing.service';
import { BillingStatusResponseDto } from '@/modules/billing/dto/billing-status.response.dto';
import {
	BillingSyncResponseDto,
	CheckoutSessionResponseDto
} from '@/modules/billing/dto/checkout-session.response.dto';
import { PrismaService } from '@/modules/prisma/prisma.service';
import type { RawBodyRequest } from '@nestjs/common';
import {
	BadRequestException,
	Controller,
	Get,
	Headers,
	HttpCode,
	HttpStatus,
	Logger,
	Post,
	Req,
	UseGuards
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type Stripe from 'stripe';

@ApiTags('billing')
@Controller('billing')
export class BillingController {
	private readonly logger = new Logger(BillingController.name);

	constructor(
		private readonly billing: BillingService,
		private readonly prisma: PrismaService,
		private readonly config: ConfigService<EnvSchema, true>
	) {}

	@ApiOperation({ summary: 'Current billing state for the active organization' })
	@ApiOkResponse({ type: BillingStatusResponseDto })
	// Read-only: any member can see trial countdown / plan / seat usage. Only owners can
	// act on it (checkout / portal / sync — all guarded with `OwnerGuard` below).
	@UseGuards(OrganizationGuard)
	@Get('status')
	async getStatus(@Req() request: Request): Promise<BillingStatusResponseDto> {
		return this.billing.getStatus(request.organizationId!);
	}

	@ApiOperation({ summary: 'Create a Stripe Checkout session for the active organization' })
	@ApiOkResponse({ type: CheckoutSessionResponseDto })
	@UseGuards(OwnerGuard)
	@Post('checkout-session')
	async createCheckoutSession(@Req() request: Request): Promise<CheckoutSessionResponseDto> {
		return this.billing.createCheckoutSession(request.organizationId!);
	}

	@ApiOperation({ summary: 'Create a Stripe Customer Portal session for self-service management' })
	@ApiOkResponse({ type: CheckoutSessionResponseDto })
	@UseGuards(OwnerGuard)
	@Post('portal-session')
	async createPortalSession(@Req() request: Request): Promise<CheckoutSessionResponseDto> {
		return this.billing.createPortalSession(request.organizationId!);
	}

	@ApiOperation({ summary: 'Refresh subscription state from Stripe after checkout success' })
	@ApiOkResponse({ type: BillingSyncResponseDto })
	@UseGuards(OwnerGuard)
	@HttpCode(HttpStatus.OK)
	@Post('sync')
	async syncAfterSuccess(@Req() request: Request): Promise<BillingSyncResponseDto> {
		const sub = await this.prisma.subscription.findUnique({
			where: { organizationId: request.organizationId! }
		});

		if (!sub) {
			return { ok: false, status: null };
		}

		const result = await this.billing.syncFromStripe(sub.stripeCustomerId);
		return { ok: true, status: result.status };
	}

	@ApiExcludeEndpoint()
	@HttpCode(HttpStatus.OK)
	@Post('webhook')
	async webhook(
		@Req() request: RawBodyRequest<Request>,
		@Headers('stripe-signature') signature: string | undefined
	): Promise<{ received: boolean }> {
		if (!signature) {
			throw new BadRequestException(STRIPE_SIGNATURE_HEADER_MISSING);
		}

		if (!request.rawBody) {
			throw new BadRequestException(STRIPE_RAW_BODY_MISSING);
		}

		const webhookSecret = this.config.get('STRIPE_WEBHOOK_SECRET', { infer: true });
		if (!webhookSecret) {
			throw new BadRequestException(STRIPE_WEBHOOK_SECRET_MISSING);
		}

		let event: ReturnType<InstanceType<typeof Stripe>['webhooks']['constructEvent']>;
		try {
			event = this.billing.stripeClient.webhooks.constructEvent(request.rawBody, signature, webhookSecret);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'unknown';
			this.logger.warn(`Stripe webhook signature verification failed: ${message}`);
			throw new BadRequestException(STRIPE_SIGNATURE_INVALID);
		}

		// Acknowledge immediately; process asynchronously to keep Stripe's retry timer happy.
		// If processing throws, we log it — Stripe won't retry because we 200'd, but the
		// next event for the same customer will re-trigger a full sync anyway (idempotent).
		setImmediate(() => {
			this.billing.handleWebhookEvent(event).catch((error: unknown) => {
				this.logger.error(
					`Webhook handler failed for event ${event.id} (${event.type}): ${
						error instanceof Error ? error.message : 'unknown'
					}`
				);
			});
		});

		return { received: true };
	}
}
