import { EmailAccountsService } from '@/modules/email-accounts/email-accounts.service';
import { GoogleOAuthService } from '@/modules/email-accounts/google-oauth.service';
import { MicrosoftOAuthService } from '@/modules/email-accounts/microsoft-oauth.service';
import { Module } from '@nestjs/common';

/**
 * Provider-agnostic mailbox-account management. Owns `EmailAccountsService` plus the
 * per-provider OAuth clients it dispatches to (Google + Microsoft today).
 *
 * Imported by `GmailModule` and `MicrosoftModule` — each provider's controller +
 * backfill stack injects `EmailAccountsService` from here. Keeping these together
 * avoids the GmailModule ↔ MicrosoftModule import cycle that would otherwise arise
 * from `EmailAccountsService` needing both OAuth clients while sitting inside one of
 * the provider modules.
 *
 * The OAuth client classes live here too (not in their respective `gmail/` /
 * `microsoft/` directories) so the file location matches the module that provides
 * them. Provider-specific REST surfaces (`GmailApiService`, `MicrosoftGraphApiService`)
 * stay in their respective directories — those don't cause the cycle.
 */
@Module({
	providers: [EmailAccountsService, GoogleOAuthService, MicrosoftOAuthService],
	exports: [EmailAccountsService, GoogleOAuthService, MicrosoftOAuthService]
})
export class EmailAccountsModule {}
