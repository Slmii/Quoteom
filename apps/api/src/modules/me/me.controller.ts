import { OrganizationGuard } from '@/modules/auth/organization.guard';
import { MembershipResponseDto } from '@/modules/me/dto/membership.response.dto';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

@ApiTags('me')
@Controller('me')
@UseGuards(OrganizationGuard)
export class MeController {
	constructor(private readonly prisma: PrismaService) {}

	@ApiOperation({ summary: 'Memberships of the active organization' })
	@ApiOkResponse({ type: [MembershipResponseDto] })
	@Get('memberships')
	async memberships(@Req() request: Request): Promise<MembershipResponseDto[]> {
		// `organizationId` is set by OrganizationGuard from the JWT session.
		// Every query in a tenant-scoped controller MUST filter by it.
		return this.prisma.membership.findMany({
			where: { organizationId: request.organizationId },
			include: { user: { select: { id: true, email: true, name: true } } }
		});
	}
}
