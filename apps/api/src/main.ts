// Must be the first import — populates process.env before any other module's
// top-level code (e.g. auth.config's PrismaClient) reads from it.
import '@/load-env';

import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import type { EnvSchema } from '@/config/env.schema';
import { authConfig } from '@/modules/auth/auth.config';
import { inngestFunctions } from '@/modules/inngest/functions';
import { inngest } from '@/modules/inngest/inngest.client';
import { LogService } from '@/modules/logger/log.service';
import { ExpressAuth } from '@auth/express';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json as expressJson } from 'express';
import { serve as inngestServe } from 'inngest/express';
import 'reflect-metadata';

async function bootstrap() {
	// `rawBody: true` exposes `request.rawBody` so the Stripe webhook handler can verify
	// the signature header against the unparsed request body. Without it Stripe's
	// `constructEvent()` always throws.
	const app = await NestFactory.create(AppModule, {
		bufferLogs: true,
		rawBody: true
	});

	app.useLogger(app.get(LogService));

	const config = app.get(ConfigService<EnvSchema, true>);

	// Behind App Platform's load balancer the real client IP arrives in `X-Forwarded-For`.
	// Without this, `req.ip` is the LB's IP and per-IP rate limits become per-app limits.
	// `1` = trust the single proxy hop in front of us (App Platform). Bump if more layers.
	app.getHttpAdapter().getInstance().set('trust proxy', 1);

	app.enableCors({
		origin: config.get('WEB_ORIGIN', { infer: true }),
		credentials: true
	});
	app.setGlobalPrefix('api');

	// Auth.js — mounted as Express middleware on /api/auth/*.
	// Sits before global pipes/filters because it handles its own request/response lifecycle.
	app.use('/api/auth', ExpressAuth(authConfig));

	// Inngest — mounted at /api/inngest. Handles 3 verbs internally:
	//   - GET:  discovery + introspection (used by the dev UI to list functions)
	//   - PUT:  register functions with the cloud (no-op in dev)
	//   - POST: run a step (called by the Inngest runtime when a function fires)
	// Like Auth.js, Inngest's serve() owns the response — keep it before global pipes.
	// Signing key is auto-read from `INNGEST_SIGNING_KEY` env (handled by the SDK).
	//
	// `expressJson()` is mounted ONLY on this path because NestJS's global body parser
	// runs after `app.use()` middleware in this lifecycle position, and Inngest's serve()
	// expects a pre-parsed JSON body on POST. We can't enable JSON parsing globally — that
	// would break Stripe's webhook signature verification, which needs the raw bytes.
	app.use(
		'/api/inngest',
		expressJson(),
		inngestServe({
			client: inngest,
			functions: inngestFunctions
		})
	);

	app.useGlobalPipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true,
			transformOptions: { enableImplicitConversion: true }
		})
	);
	app.useGlobalFilters(new AllExceptionsFilter());

	const swaggerConfig = new DocumentBuilder()
		.setTitle('Quoteom API')
		.setDescription('Offerte management for Dutch SMBs')
		.setVersion('0.0.0')
		.addBearerAuth()
		.build();

	const document = SwaggerModule.createDocument(app, swaggerConfig);
	SwaggerModule.setup('docs', app, document, {
		jsonDocumentUrl: 'docs/openapi.json'
	});

	const port = config.get('API_PORT', { infer: true });
	await app.listen(port);

	const bootLog = new Logger('Bootstrap');
	bootLog.log(`API listening on http://localhost:${port}`);
	bootLog.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();
