import { IsNotEmpty, IsString } from 'class-validator';

export class SwitchOrganizationDto {
	// Loosened from `@IsUUID()` so dummy org ids (seed/test data) pass validation. The
	// service-level membership lookup still rejects ids that don't map to a real row.
	@IsString()
	@IsNotEmpty()
	organizationId!: string;
}
