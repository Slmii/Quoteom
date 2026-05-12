import { AuthGuard } from '@/modules/auth/auth.guard';
import { OrganizationGuard } from '@/modules/auth/organization.guard';
import { OwnerGuard } from '@/modules/auth/owner.guard';
import { Module } from '@nestjs/common';

@Module({
	providers: [AuthGuard, OrganizationGuard, OwnerGuard],
	exports: [AuthGuard, OrganizationGuard, OwnerGuard]
})
export class AuthModule {}
