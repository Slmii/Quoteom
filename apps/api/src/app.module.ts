import { AppController } from '@/app.controller';
import { AppService } from '@/app.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { PrismaService } from '@/prisma/prisma.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [PrismaModule],
	controllers: [AppController],
	providers: [AppService, PrismaService]
})
export class AppModule {}
