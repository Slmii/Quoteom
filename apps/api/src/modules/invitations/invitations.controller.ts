import { OrganizationGuard } from '@/modules/auth/organization.guard';
import { OwnerWrite } from '@/modules/billing/owner-write.decorator';
import { AcceptInvitationDto } from '@/modules/invitations/dto/accept-invitation.dto';
import { AcceptInvitationResponseDto } from '@/modules/invitations/dto/accept-invitation.response.dto';
import { CreateInvitationDto } from '@/modules/invitations/dto/create-invitation.dto';
import { InvitationResponseDto } from '@/modules/invitations/dto/invitation.response.dto';
import { InvitationsService } from '@/modules/invitations/invitations.service';
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
	UseGuards
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

@ApiTags('invitations')
@Controller('invitations')
export class InvitationsController {
	constructor(private readonly invitations: InvitationsService) {}

	@ApiOperation({ summary: 'Create an invitation for the active organization' })
	@ApiOkResponse({ type: InvitationResponseDto })
	@OwnerWrite()
	@Post()
	async create(@Req() request: Request, @Body() body: CreateInvitationDto): Promise<InvitationResponseDto> {
		return this.invitations.create({
			email: body.email,
			organizationId: request.organizationId!,
			role: body.role
		});
	}

	@ApiOperation({ summary: 'List pending (un-accepted, un-expired) invitations for the active organization' })
	@ApiOkResponse({ type: [InvitationResponseDto] })
	@UseGuards(OrganizationGuard)
	@Get()
	async list(@Req() request: Request): Promise<InvitationResponseDto[]> {
		return this.invitations.listPending(request.organizationId!);
	}

	@ApiOperation({ summary: 'Revoke a pending invitation' })
	@OwnerWrite()
	@HttpCode(HttpStatus.NO_CONTENT)
	@Delete(':id')
	async revoke(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
		await this.invitations.revoke(id, request.organizationId!);
	}

	@ApiOperation({ summary: 'Redeem an invitation token — creates user + membership' })
	@ApiOkResponse({ type: AcceptInvitationResponseDto })
	@HttpCode(HttpStatus.OK)
	@Post('accept')
	async accept(@Body() body: AcceptInvitationDto): Promise<AcceptInvitationResponseDto> {
		return this.invitations.accept(body.token);
	}
}
