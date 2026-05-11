import { AppService, type HelloResponse } from '@/app.service';
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('app')
@Controller()
export class AppController {
	constructor(private readonly appService: AppService) {}

	@ApiOperation({ summary: 'Hello world — stack-wiring sanity check' })
	@Get('hello')
	getHello(): HelloResponse {
		return this.appService.getHello();
	}

	@ApiOperation({ summary: 'Liveness probe' })
	@Get('healthz')
	getHealth(): { ok: true } {
		return { ok: true };
	}
}
