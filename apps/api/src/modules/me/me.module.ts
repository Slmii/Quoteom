import { AuthModule } from '@/modules/auth/auth.module';
import { BillingModule } from '@/modules/billing/billing.module';
import { MeController } from '@/modules/me/me.controller';
import { MeService } from '@/modules/me/me.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AuthModule, BillingModule],
	controllers: [MeController],
	providers: [MeService],
	exports: [MeService]
})
export class MeModule {}
