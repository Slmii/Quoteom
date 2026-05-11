import { MISSING_ORG_CONTEXT, TRIAL_ENDED } from '@/lib/errors';
import {
	BILLING_REQUIRED_CODE,
	ENTITLED_STRIPE_STATUSES,
	LOCAL_TRIAL_MS,
	READ_METHODS
} from '@/modules/billing/billing.constants';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Gates write routes (POST/PATCH/PUT/DELETE) behind subscription entitlement.
 *
 * Must run AFTER OrganizationGuard so that `request.organizationId` is populated.
 * Compose via the `@TenantWrite()` decorator (recommended) or with
 * `@UseGuards(OrganizationGuard, TrialGateGuard)` directly.
 *
 * Entitled paths:
 *  - Subscription.status ∈ {trialing, active, past_due}  → Stripe-managed entitlement.
 *  - No Stripe subscription yet AND org is younger than LOCAL_TRIAL_DAYS  → local grace.
 *
 * Everything else returns 402 with `{ code: 'billing_required' }`.
 */
@Injectable()
export class TrialGateGuard implements CanActivate {
	constructor(private readonly prisma: PrismaService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<Request>();

		if (READ_METHODS.includes(request.method)) {
			return true;
		}

		const organizationId = request.organizationId;
		if (!organizationId) {
			// OrganizationGuard didn't run or failed silently — fail closed by throwing
			// the standard 402 rather than silently passing. This should never happen
			// in normal flow but defensive coding here is cheap.
			throw this.billingRequired(MISSING_ORG_CONTEXT);
		}

		const sub = await this.prisma.subscription.findUnique({
			where: { organizationId },
			select: { status: true, stripeSubscriptionId: true }
		});

		if (sub?.status && ENTITLED_STRIPE_STATUSES.includes(sub.status)) {
			return true;
		}

		// Local grace window only applies before the org has ever held a Stripe subscription.
		// Once they've had one and it lapsed, they don't get the new-org grace back.
		if (!sub?.stripeSubscriptionId) {
			const org = await this.prisma.organization.findUnique({
				where: { id: organizationId },
				select: { createdAt: true }
			});

			if (org && Date.now() - org.createdAt.getTime() < LOCAL_TRIAL_MS) {
				return true;
			}
		}

		throw this.billingRequired(TRIAL_ENDED);
	}

	private billingRequired(message: string): HttpException {
		return new HttpException(
			{
				statusCode: HttpStatus.PAYMENT_REQUIRED,
				code: BILLING_REQUIRED_CODE,
				message,
				billingPath: '/billing'
			},
			HttpStatus.PAYMENT_REQUIRED
		);
	}
}
