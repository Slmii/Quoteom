import { OwnerGuard } from '@/modules/auth/owner.guard';
import { TrialGateGuard } from '@/modules/billing/trial-gate.guard';
import { applyDecorators, UseGuards } from '@nestjs/common';

/**
 * Composite decorator for tenant-scoped write endpoints that require the OWNER role.
 * Applies:
 *  1. OwnerGuard — authenticates + verifies the current user holds OWNER on the active org
 *     (extends OrganizationGuard, so the auth + org checks happen exactly once).
 *  2. TrialGateGuard — returns 402 if the org's trial has ended without a payment method.
 *
 * Use on every controller method that mutates tenant data AND should be restricted to the
 * owner (billing actions, team invite/revoke, future destructive admin actions). For
 * member-accessible writes use `@TenantWrite()`; for member-readable routes use
 * `@UseGuards(OrganizationGuard)` alone.
 */
export function OwnerWrite(): ClassDecorator & MethodDecorator {
	return applyDecorators(UseGuards(OwnerGuard, TrialGateGuard));
}
