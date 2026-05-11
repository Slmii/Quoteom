import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { LogService } from '@/common/logger/log.service';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import 'reflect-metadata';

// Load apps/api/.env (works for both src/main.ts in dev and dist/main.js in prod).
config({ path: resolve(__dirname, '../.env') });

async function bootstrap() {
	const app = await NestFactory.create(AppModule, { bufferLogs: true });
	app.useLogger(app.get(LogService));

	app.enableCors({
		origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
		credentials: true
	});
	app.setGlobalPrefix('api');

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

	const port = Number(process.env.API_PORT ?? 3001);
	await app.listen(port);

	console.log(`API listening on http://localhost:${port}`);
	console.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();
