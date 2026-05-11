import { PrismaService } from '@/modules/prisma/prisma.service';
import { ConsoleLogger, Injectable } from '@nestjs/common';
import { LogLevel as PrismaLogLevel } from '@/generated/prisma/client';

type Loggable = unknown;

interface PersistOptions {
	context?: string;
	stack?: string;
	metadata?: Record<string, unknown>;
}

@Injectable()
export class LogService extends ConsoleLogger {
	constructor(private readonly prisma: PrismaService) {
		super('App');
	}

	override fatal(message: Loggable, ...rest: unknown[]): void {
		super.fatal(message as never, ...(rest as never[]));
		void this.persist('FATAL', message, this.extractOptions(rest));
	}

	override error(message: Loggable, stack?: string, context?: string): void {
		super.error(message as never, stack, context);
		void this.persist('ERROR', message, { stack, context });
	}

	override warn(message: Loggable, context?: string): void {
		super.warn(message as never, context);
		void this.persist('WARN', message, { context });
	}

	// log/debug/verbose deliberately do NOT persist — they'd flood the table.

	private extractOptions(rest: unknown[]): PersistOptions {
		const last = rest[rest.length - 1];
		return { context: typeof last === 'string' ? last : undefined };
	}

	private async persist(
		level: PrismaLogLevel,
		message: Loggable,
		options: PersistOptions
	): Promise<void> {
		try {
			await this.prisma.log.create({
				data: {
					level,
					message: this.serialize(message),
					context: options.context,
					stack: options.stack,
					metadata: options.metadata as never
				}
			});
		} catch {
			// Never let log persistence crash the caller.
			// (If Postgres is down, we still got console output.)
		}
	}

	private serialize(message: Loggable): string {
		if (typeof message === 'string') return message;
		if (message instanceof Error) return message.message;
		try {
			return JSON.stringify(message);
		} catch {
			return String(message);
		}
	}
}
