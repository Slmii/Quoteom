import { GmailModule } from '@/modules/gmail/gmail.module';
import { MicrosoftModule } from '@/modules/microsoft/microsoft.module';
import { GmailBackfillFunction } from '@/modules/inngest/functions/gmail-backfill.function';
import { MicrosoftBackfillFunction } from '@/modules/inngest/functions/microsoft-backfill.function';
import { Module } from '@nestjs/common';

/**
 * Inngest itself is wired as Express middleware in `main.ts` — same pattern as Auth.js.
 * What this module does is house the `@Injectable()` wrappers that expose Inngest
 * functions needing Nest DI (services, Prisma, etc.). main.ts resolves each wrapper via
 * `app.get(...)` after `NestFactory.create()` and adds its `.inngestFn` to the array
 * passed to `serve()`.
 *
 * Trivial functions that don't need DI (the W3.3 `helloFn` and `heartbeatFn`) live as
 * free constants in `functions/index.ts` and don't go through Nest. Mixed-mode is fine —
 * the `serve()` array just gets both flavors concatenated.
 */
@Module({
	imports: [GmailModule, MicrosoftModule],
	providers: [GmailBackfillFunction, MicrosoftBackfillFunction],
	exports: [GmailBackfillFunction, MicrosoftBackfillFunction]
})
export class InngestModule {}
