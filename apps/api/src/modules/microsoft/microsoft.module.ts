import { AuthModule } from '@/modules/auth/auth.module';
import { EmailAccountsModule } from '@/modules/email-accounts/email-accounts.module';
import { MicrosoftBackfillService } from '@/modules/microsoft/microsoft-backfill.service';
import { MicrosoftController } from '@/modules/microsoft/microsoft.controller';
import { MicrosoftGraphApiService } from '@/modules/microsoft/microsoft-graph-api.service';
import { Module } from '@nestjs/common';

/**
 * Microsoft Graph integration (W3.2). Parallels `GmailModule` for the second provider.
 *
 * Account-management services (`EmailAccountsService` + `MicrosoftOAuthService`) come
 * from `EmailAccountsModule` — same pattern as `GmailModule`.
 *
 * Same role + entitlement gates as Gmail: OWNER + MEMBER can connect; EXTERNAL is
 * blocked at the guard layer; new connections require an entitled billing state.
 */
@Module({
	imports: [AuthModule, EmailAccountsModule],
	controllers: [MicrosoftController],
	providers: [MicrosoftGraphApiService, MicrosoftBackfillService],
	exports: [MicrosoftGraphApiService, MicrosoftBackfillService]
})
export class MicrosoftModule {}
