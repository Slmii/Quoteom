import { Module } from '@nestjs/common';

/**
 * Placeholder module. Inngest itself is wired as Express middleware in `main.ts` (the
 * same pattern Auth.js uses) — it doesn't need NestJS providers to function.
 *
 * The module exists so:
 *  - There's a stable home for any future Inngest-related Nest services (e.g. a service
 *    that emits events programmatically).
 *  - The `src/modules/inngest/` directory has a Module class matching the convention of
 *    every other module in the project.
 *
 * Functions themselves live under `functions/` and are registered at the `serve()` call
 * in main.ts — they don't go through Nest DI today. W3.4 (backfill) will revisit this:
 * the backfill function needs to call `GmailApiService` etc., which will require either
 * a bridge or passing services as args at registration time.
 */
@Module({})
export class InngestModule {}
