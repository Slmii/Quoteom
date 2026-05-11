import { AcceptInvitationDto } from '@/modules/invitations/dto/accept-invitation.dto';
import { AcceptInvitationResponseDto } from '@/modules/invitations/dto/accept-invitation.response.dto';
import { InvitationsService } from '@/modules/invitations/invitations.service';
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('invitations')
@Controller('invitations')
export class InvitationsController {
	constructor(private readonly invitations: InvitationsService) {}

	@ApiOperation({ summary: 'Redeem an invitation token — creates user + membership' })
	@ApiOkResponse({ type: AcceptInvitationResponseDto })
	@HttpCode(HttpStatus.OK)
	@Post('accept')
	async accept(@Body() body: AcceptInvitationDto): Promise<AcceptInvitationResponseDto> {
		return this.invitations.accept(body.token);
	}
}
