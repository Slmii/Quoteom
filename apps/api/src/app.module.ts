import { AppController } from '@/app.controller';
import { AppService } from '@/app.service';
import { validateEnv } from '@/config/env.schema';
import { AuthModule } from '@/modules/auth/auth.module';
import { BillingModule } from '@/modules/billing/billing.module';
import { InvitationsModule } from '@/modules/invitations/invitations.module';
import { LogModule } from '@/modules/logger/log.module';
import { MeModule } from '@/modules/me/me.module';
import { PrismaModule } from '@/modules/prisma/prisma.module';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
	imports: [
		// Global ConfigModule — ConfigService is injectable everywhere without re-importing.
		// `validate` runs the Zod schema against process.env at boot; bad env = startup fails.
		ConfigModule.forRoot({
			isGlobal: true,
			validate: validateEnv,
			cache: true
		}),
		PrismaModule,
		LogModule,
		AuthModule,
		InvitationsModule,
		MeModule,
		BillingModule
	],
	controllers: [AppController],
	providers: [AppService, PrismaService]
})
export class AppModule {}
