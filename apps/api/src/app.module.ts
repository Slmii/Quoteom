import { AppController } from '@/app.controller';
import { AppService } from '@/app.service';
import { AuthModule } from '@/modules/auth/auth.module';
import { LogModule } from '@/modules/logger/log.module';
import { InvitationsModule } from '@/modules/invitations/invitations.module';
import { MeModule } from '@/modules/me/me.module';
import { PrismaModule } from '@/modules/prisma/prisma.module';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [PrismaModule, LogModule, AuthModule, InvitationsModule, MeModule],
	controllers: [AppController],
	providers: [AppService, PrismaService]
})
export class AppModule {}
