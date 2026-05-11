import { AuthModule } from '@/modules/auth/auth.module';
import { MeController } from '@/modules/me/me.controller';
import { Module } from '@nestjs/common';

@Module({
	imports: [AuthModule],
	controllers: [MeController]
})
export class MeModule {}
