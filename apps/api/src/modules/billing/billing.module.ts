import { AuthModule } from '@/modules/auth/auth.module';
import { BillingController } from '@/modules/billing/billing.controller';
import { BillingService } from '@/modules/billing/billing.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AuthModule],
	controllers: [BillingController],
	providers: [BillingService],
	exports: [BillingService]
})
export class BillingModule {}
