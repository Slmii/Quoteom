import { AuthModule } from '@/modules/auth/auth.module';
import { MeController } from '@/modules/me/me.controller';
import { MeService } from '@/modules/me/me.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AuthModule],
	controllers: [MeController],
	providers: [MeService],
	exports: [MeService]
})
export class MeModule {}
