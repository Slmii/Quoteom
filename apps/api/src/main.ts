// Must be the first import — populates process.env before any other module's
// top-level code (e.g. auth.config's PrismaClient) reads from it.
import '@/load-env';

import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import type { EnvSchema } from '@/config/env.schema';
import { authConfig } from '@/modules/auth/auth.config';
import { LogService } from '@/modules/logger/log.service';
import { ExpressAuth } from '@auth/express';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

	app.enableCors({
		origin: config.get('WEB_ORIGIN', { infer: true }),
		credentials: true
	});
	app.setGlobalPrefix('api');

	// Auth.js — mounted as Express middleware on /api/auth/*.
	// Sits before global pipes/filters because it handles its own request/response lifecycle.
	app.use('/api/auth', ExpressAuth(authConfig));

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
