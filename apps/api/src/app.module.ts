import { AppController } from '@/app.controller';
import { AppService } from '@/app.service';
import { validateEnv } from '@/config/env.schema';
import { AuthModule } from '@/modules/auth/auth.module';
import { BillingModule } from '@/modules/billing/billing.module';
import { GmailModule } from '@/modules/gmail/gmail.module';
import { InngestModule } from '@/modules/inngest/inngest.module';
import { InvitationsModule } from '@/modules/invitations/invitations.module';
import { LogModule } from '@/modules/logger/log.module';
import { MeModule } from '@/modules/me/me.module';
import { PrismaModule } from '@/modules/prisma/prisma.module';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

@Module({
	imports: [
		// Global ConfigModule — ConfigService is injectable everywhere without re-importing.
		// `validate` runs the Zod schema against process.env at boot; bad env = startup fails.
		ConfigModule.forRoot({
			isGlobal: true,
			validate: validateEnv,
			cache: true
		}),

		// Per-IP rate limiting. Defaults are deliberately loose — only abuse-prone routes
		// (signup, magic-link request) tighten via `@Throttle()`. Stripe's webhook is
		// `@SkipThrottle()`-ed below since Stripe retries aggressively on transient failures.
		// `trust proxy` is set in main.ts so request IPs come from X-Forwarded-For in prod
		// (App Platform load balancer).
		ThrottlerModule.forRoot([
			{ name: 'default', ttl: 60_000, limit: 60 } // 60 requests / minute / IP, global
		]),

		PrismaModule,
		LogModule,
		AuthModule,
		InvitationsModule,
		MeModule,
		BillingModule,
		GmailModule,
		InngestModule
	],
	controllers: [AppController],
	providers: [AppService, PrismaService, { provide: APP_GUARD, useClass: ThrottlerGuard }]
})
export class AppModule {}
