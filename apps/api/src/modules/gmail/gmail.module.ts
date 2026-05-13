import { AuthModule } from '@/modules/auth/auth.module';
import { EmailAccountsModule } from '@/modules/email-accounts/email-accounts.module';
import { GmailApiService } from '@/modules/gmail/gmail-api.service';
import { GmailBackfillService } from '@/modules/gmail/gmail-backfill.service';
import { GmailController } from '@/modules/gmail/gmail.controller';
import { Module } from '@nestjs/common';

/**
 * Gmail integration (W3.1 + W3.4). Hosts the Gmail-specific HTTP routes, REST client,
 * and backfill worker.
 *
 * Account-management services (`EmailAccountsService` + `GoogleOAuthService`) come from
 * `EmailAccountsModule` — those are shared across providers and live there to avoid
 * a circular dep with `MicrosoftModule`.
 *
 * Member-or-owner write routes use `@MemberWrite()` (entitlement-gated). Status + messages
 * reads use `TenantMemberGuard` alone. EXTERNAL is rejected at the guard layer.
 *
 * `GmailBackfillService` is exported so the InngestModule's `GmailBackfillFunction`
 * wrapper can inject it.
 */
@Module({
	imports: [AuthModule, EmailAccountsModule],
	controllers: [GmailController],
	providers: [GmailApiService, GmailBackfillService],
	exports: [GmailApiService, GmailBackfillService]
})
export class GmailModule {}
