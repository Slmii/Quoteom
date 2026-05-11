import { LogService } from '@/modules/logger/log.service';
import { Global, Module } from '@nestjs/common';

@Global()
@Module({
	providers: [LogService],
	exports: [LogService]
})
export class LogModule {}
