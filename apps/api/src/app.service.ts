import type { HelloResponse } from '@/lib/interfaces/hello';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AppService {
	private readonly logger = new Logger(AppService.name);

	getHello(): HelloResponse {
		// One call per level so you can verify what gets persisted vs console-only.
		// `log`, `debug`, `verbose` → console only.
		// `warn`, `error`, `fatal`  → console + Log table.
		this.logger.verbose('verbose: getHello called (console only)');
		this.logger.debug('debug: getHello called (console only)');
		this.logger.log('log: getHello called (console only)');
		this.logger.warn('warn: getHello called (persisted)');
		this.logger.error('error: getHello called (persisted)', new Error('demo stack').stack);
		this.logger.fatal('fatal: getHello called (persisted)');

		return {
			message: 'Hello from Quoteom API',
			timestamp: new Date().toISOString()
		};
	}
}
