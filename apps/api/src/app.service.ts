import type { HelloResponse } from '@/lib/interfaces/hello';
import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
	getHello(): HelloResponse {
		return {
			message: 'Hello from Quoteom API',
			timestamp: new Date().toISOString()
		};
	}
}
