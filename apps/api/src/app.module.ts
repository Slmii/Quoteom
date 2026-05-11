import { AppController } from '@/app.controller';
import { AppService } from '@/app.service';
import { LogModule } from '@/common/logger/log.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { PrismaService } from '@/prisma/prisma.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [PrismaModule, LogModule],
	controllers: [AppController],
	providers: [AppService, PrismaService]
})
export class AppModule {}
