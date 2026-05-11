import { AppService } from '@/app.service';
import { HealthResponseDto, HelloResponseDto } from '@/dto/hello.response.dto';
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('app')
@Controller()
export class AppController {
	constructor(private readonly appService: AppService) {}

	@ApiOperation({ summary: 'Hello world — stack-wiring sanity check' })
	@ApiOkResponse({ type: HelloResponseDto })
	@Get('hello')
	getHello(): HelloResponseDto {
		return this.appService.getHello();
	}

	@ApiOperation({ summary: 'Liveness probe' })
	@ApiOkResponse({ type: HealthResponseDto })
	@Get('health')
	getHealth(): HealthResponseDto {
		return { ok: true };
	}
}
