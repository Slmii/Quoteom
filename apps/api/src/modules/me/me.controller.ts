import { AuthGuard } from '@/common/guards/auth.guard';
import { OrganizationGuard } from '@/common/guards/organization.guard';
import { OwnerGuard } from '@/common/guards/owner.guard';
import { NOT_AUTHENTICATED } from '@/lib/errors';
import { MembershipResponseDto } from '@/modules/me/dto/membership.response.dto';
import { SwitchOrganizationDto } from '@/modules/me/dto/switch-organization.dto';
import { MeService } from '@/modules/me/me.service';
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Param,
	ParseUUIDPipe,
	Post,
	Req,
	UnauthorizedException,
	UseGuards
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

/**
 * `MeController` mixes two access modes:
 *  - Active-org-scoped reads/writes (`/memberships`, `/membership`, `DELETE /memberships/:id`)
 *    use `OrganizationGuard` (or `OwnerGuard` which extends it).
 *  - "Help me find / pick an org" routes (`/organizations`, `POST /switch-organization`)
 *    use plain `AuthGuard` because these are exactly what the UI needs when the user has
 *    `currentOrganizationId = null` (e.g. they were the last removed member of their only
 *    org). Gating them on OrganizationGuard would make the no-org empty state impossible
 *    to render — the UI couldn't list orgs to switch into.
 *
 * NOTE: do NOT add a class-level `@UseGuards(...)` here. Per-method guards keep the two
 * modes explicit and avoid a future refactor accidentally tightening an unscoped route.
 */
@ApiTags('me')
@Controller('me')
export class MeController {
	constructor(private readonly me: MeService) {}

	@ApiOperation({ summary: 'Memberships of the active organization' })
	@ApiOkResponse({ type: [MembershipResponseDto] })
	@UseGuards(OrganizationGuard)
	@Get('memberships')
	memberships(@Req() request: Request): Promise<MembershipResponseDto[]> {
		return this.me.listOrgMembers(request.organizationId!);
	}

	@ApiOperation({ summary: "Current user's membership in the active organization (role + user + org)" })
	@ApiOkResponse({ type: MembershipResponseDto })
	@UseGuards(OrganizationGuard)
	@Get('membership')
	async myMembership(@Req() request: Request): Promise<MembershipResponseDto> {
		return this.me.findMyMembership(this.userId(request), request.organizationId!);
	}

	@ApiOperation({ summary: 'All organizations the current user is a member of (for the org switcher)' })
	@ApiOkResponse({ type: [MembershipResponseDto] })
	@UseGuards(AuthGuard)
	@Get('organizations')
	myOrganizations(@Req() request: Request): Promise<MembershipResponseDto[]> {
		return this.me.listMyOrganizations(this.userId(request));
	}

	@ApiOperation({ summary: 'Switch the active organization for the current user' })
	@ApiOkResponse({ type: MembershipResponseDto })
	@UseGuards(AuthGuard)
	@Post('switch-organization')
	switchOrganization(@Req() request: Request, @Body() body: SwitchOrganizationDto): Promise<MembershipResponseDto> {
		return this.me.switchActiveOrganization(this.userId(request), body.organizationId);
	}

	/**
	 * Remove a member from the active organization. Owner-only.
	 *
	 * `@UseGuards(OwnerGuard)` (NOT `@OwnerWrite()`) — we deliberately don't gate on
	 * entitlement here. An org that's been canceled / past_due should still be able to
	 * clean up its team; the remove also reduces seat count which is the *opposite* of
	 * what you'd want to block during a billing problem.
	 *
	 * 204 No Content on success — the caller already has the membership list cached and
	 * just refetches after the mutation. `ParseUUIDPipe` rejects garbage path params at
	 * the framework layer before the service runs.
	 */
	@ApiOperation({ summary: "Remove a member from the active organization (owner-only)" })
	@ApiNoContentResponse()
	@UseGuards(OwnerGuard)
	@HttpCode(HttpStatus.NO_CONTENT)
	@Delete('memberships/:userId')
	async removeMember(
		@Req() request: Request,
		@Param('userId', new ParseUUIDPipe()) targetUserId: string
	): Promise<void> {
		await this.me.removeMember(this.userId(request), request.organizationId!, targetUserId);
	}

	/**
	 * `OrganizationGuard` guarantees `authSession.user.id` is set; the narrowing here is
	 * just to satisfy TypeScript. 401 is defensive — should never fire in practice.
	 */
	private userId(request: Request): string {
		const id = request.authSession?.user?.id;
		if (!id) {
			throw new UnauthorizedException(NOT_AUTHENTICATED);
		}
		return id;
	}
}
