import { AuthGuard } from '@/auth/auth.guard';
import { OrganizationGuard } from '@/auth/organization.guard';
import { Module } from '@nestjs/common';

@Module({
	providers: [AuthGuard, OrganizationGuard],
	exports: [AuthGuard, OrganizationGuard]
})
export class AuthModule {}
