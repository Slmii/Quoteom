import { AuthGuard } from '@/modules/auth/auth.guard';
import { OrganizationGuard } from '@/modules/auth/organization.guard';
import { Module } from '@nestjs/common';

@Module({
	providers: [AuthGuard, OrganizationGuard],
	exports: [AuthGuard, OrganizationGuard]
})
export class AuthModule {}
