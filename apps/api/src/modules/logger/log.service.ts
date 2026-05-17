import { LogLevel as PrismaLogLevel } from '@/generated/prisma/client';
import { logContext } from '@/modules/logger/log-context';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { ConsoleLogger, Injectable } from '@nestjs/common';

type Loggable = unknown;

interface PersistOptions {
	context?: string;
	stack?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Structured action log — the ONLY path to persistence in application code. Every audit-
 * worthy domain event (billing changes, mailbox connect/disconnect, system errors, etc.)
 * goes through this method. Always writes a `Log` row regardless of level; `level`
 * controls how it's surfaced on the console AND what level the row is written at.
 *
 *  - `action`   dot-namespaced verb (`billing.subscription.synced`, `email.disconnect`).
 *               Mandatory — this is the queryable column (`metadata->>'action'`).
 *  - `message`  human-readable summary for the `Log.message` column + console.
 *  - `metadata` structured payload stored in `Log.metadata` (jsonb). Keep it short and
 *               scrubbed — no tokens, no secrets, no message bodies. Provider IDs, status
 *               transitions, counts are fine.
 *  - `level`    defaults to `'log'` (→ INFO row). Use `'warn'` for soft failures, `'error'`
 *               or `'fatal'` for system faults (Stripe API exception, etc.).
 *  - `stack`    optional stack trace string. Only useful at error/fatal levels — populates
 *               the `Log.stack` column for post-mortem debugging.
 *  - `context`  Nest-style component name (`'BillingService'`). Defaults to `'Action'`.
 */
export interface ActionLog {
	action: string;
	message: string;
	metadata?: Record<string, unknown>;
	level?: 'log' | 'warn' | 'error' | 'fatal';
	stack?: string;
	context?: string;
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
	// Audit-worthy `log`-level events go through `logAction(...)` below, which ALWAYS
	// persists regardless of level. That's the only path that writes INFO rows.

	/**
	 * Persist a structured audit event. Mirrors the line to the console at the requested
	 * level so live dev output still shows it, but unlike the standard `log()` it always
	 * writes a row — that's the whole point.
	 *
	 * Caller responsibility: keep `metadata` PII-light and secret-free. The `Log` table
	 * is queried for ops debugging, not encrypted, and shouldn't be carrying tokens.
	 */
	logAction(entry: ActionLog): void {
		const context = entry.context ?? 'Action';
		const consoleLine = `[${entry.action}] ${entry.message}`;
		const level = entry.level ?? 'log';

		switch (level) {
			case 'fatal':
				super.fatal(consoleLine, context);
				break;
			case 'error':
				super.error(consoleLine, entry.stack, context);
				break;
			case 'warn':
				super.warn(consoleLine, context);
				break;
			default:
				super.log(consoleLine, context);
				break;
		}

		const persistLevel: PrismaLogLevel = (
			{
				fatal: 'FATAL',
				error: 'ERROR',
				warn: 'WARN',
				log: 'INFO'
			} as const
		)[level];
		const metadata: Record<string, unknown> = { action: entry.action, ...(entry.metadata ?? {}) };
		void this.persist(persistLevel, entry.message, { context, metadata, stack: entry.stack });
	}

	private extractOptions(rest: unknown[]): PersistOptions {
		const last = rest[rest.length - 1];
		return { context: typeof last === 'string' ? last : undefined };
	}

	private async persist(level: PrismaLogLevel, message: Loggable, options: PersistOptions): Promise<void> {
		try {
			const ctx = logContext.get();
			await this.prisma.log.create({
				data: {
					level,
					message: this.serialize(message),
					context: options.context,
					stack: options.stack,
					metadata: options.metadata as never,
					requestId: ctx?.requestId,
					userId: ctx?.userId,
					organizationId: ctx?.organizationId
				}
			});
		} catch {
			// Never let log persistence crash the caller.
			// (If Postgres is down, we still got console output.)
		}
	}

	private serialize(message: Loggable): string {
		if (typeof message === 'string') {
			return message;
		}

		if (message instanceof Error) {
			return message.message;
		}

		try {
			return JSON.stringify(message);
		} catch {
			return String(message);
		}
	}
}
