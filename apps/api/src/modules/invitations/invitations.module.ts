import { InvitationsController } from '@/modules/invitations/invitations.controller';
import { InvitationsService } from '@/modules/invitations/invitations.service';
import { Module } from '@nestjs/common';

@Module({
	controllers: [InvitationsController],
	providers: [InvitationsService],
	exports: [InvitationsService]
})
export class InvitationsModule {}
