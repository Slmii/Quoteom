import { IsString, IsUUID, Length } from 'class-validator';

export class AcceptInvitationDto {
	@IsString()
	@Length(32, 128)
	token!: string;
}

export class CreateInvitationDto {
	@IsString()
	email!: string;

	@IsUUID()
	organizationId!: string;
}
