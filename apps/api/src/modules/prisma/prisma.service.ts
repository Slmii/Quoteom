import type { EnvSchema } from '@/config/env.schema';
import { PrismaClient } from '@/generated/prisma/client';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient {
	constructor(config: ConfigService<EnvSchema, true>) {
		const adapter = new PrismaPg({ connectionString: config.get('DATABASE_URL', { infer: true }) });

		super({ adapter });
	}

	async onModuleInit() {
		await this.$connect();
	}

	async onModuleDestroy() {
		await this.$disconnect();
	}
}
