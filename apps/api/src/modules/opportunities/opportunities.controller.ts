import { OrganizationGuard } from '@/common/guards/organization.guard';
import { TenantWrite } from '@/common/decorators/tenant-write.decorator';
import { NOT_AUTHENTICATED } from '@/lib/errors';
import { DismissOpportunityDto } from '@/modules/opportunities/dto/dismiss-opportunity.dto';
import { ListOpportunitiesQueryDto } from '@/modules/opportunities/dto/list-opportunities-query.dto';
import { OpportunityListResponseDto } from '@/modules/opportunities/dto/opportunity-list.response.dto';
import { OpportunityResponseDto } from '@/modules/opportunities/dto/opportunity.response.dto';
import { UpdateOpportunityStatusDto } from '@/modules/opportunities/dto/update-opportunity-status.dto';
import { OpportunitiesService } from '@/modules/opportunities/opportunities.service';
import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	ParseUUIDPipe,
	Patch,
	Query,
	Req,
	UnauthorizedException,
	UseGuards
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

@ApiTags('opportunities')
@Controller('opportunities')
export class OpportunitiesController {
	constructor(private readonly opportunities: OpportunitiesService) {}

	@ApiOperation({ summary: 'List opportunities for the active organization' })
	@ApiOkResponse({ type: OpportunityListResponseDto })
	@UseGuards(OrganizationGuard)
	@Get()
	list(@Req() request: Request, @Query() query: ListOpportunitiesQueryDto): Promise<OpportunityListResponseDto> {
		return this.opportunities.list(request.organizationId!, {
			cursor: query.cursor ?? null,
			limit: query.limit ?? null,
			status: query.status ?? null,
			search: query.search ?? null,
			dismissed: query.dismissed ?? null
		});
	}

	@ApiOperation({ summary: 'Update an opportunity status' })
	@ApiOkResponse({ type: OpportunityResponseDto })
	@TenantWrite()
	@Patch(':id/status')
	updateStatus(
		@Req() request: Request,
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() body: UpdateOpportunityStatusDto
	): Promise<OpportunityResponseDto> {
		return this.opportunities.updateStatus(request.organizationId!, id, body.status);
	}

	@ApiOperation({ summary: 'Dismiss an opportunity (classifier feedback)' })
	@ApiOkResponse({ type: OpportunityResponseDto })
	@TenantWrite()
	@Patch(':id/dismiss')
	dismiss(
		@Req() request: Request,
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() body: DismissOpportunityDto
	): Promise<OpportunityResponseDto> {
		const actorUserId = requireUserId(request);
		return this.opportunities.dismiss(request.organizationId!, id, body.reason, actorUserId, body.notes ?? null);
	}

	@ApiOperation({ summary: 'Un-dismiss an opportunity' })
	@ApiOkResponse({ type: OpportunityResponseDto })
	@TenantWrite()
	@Delete(':id/dismiss')
	undismiss(@Req() request: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<OpportunityResponseDto> {
		const actorUserId = requireUserId(request);
		return this.opportunities.undismiss(request.organizationId!, id, actorUserId);
	}
}

/**
 * Pulls the authenticated user's id off the Auth.js session attached by `AuthGuard`.
 * `AuthGuard` is composed into `@TenantWrite()`, so by the time a controller method
 * runs this is guaranteed to be set — the throw branch is defensive belt-and-braces.
 */
function requireUserId(request: Request): string {
	const userId = request.authSession?.user?.id;
	if (!userId) {
		throw new UnauthorizedException(NOT_AUTHENTICATED);
	}
	return userId;
}
