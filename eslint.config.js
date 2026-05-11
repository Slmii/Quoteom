import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: [
			'**/node_modules/**',
			'**/dist/**',
			'**/.output/**',
			'**/.nitro/**',
			'**/.tanstack/**',
			'**/.turbo/**',
			'**/generated/**',
			'**/routeTree.gen.ts'
		]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			'@typescript-eslint/consistent-type-imports': 'warn'
		}
	},
	{
		// NestJS reads constructor parameter *types* at runtime via reflect-metadata.
		// `import type` erases the value, breaking dependency injection.
		// Disable the rule for files that participate in the DI graph.
		files: [
			'apps/api/**/*.controller.ts',
			'apps/api/**/*.service.ts',
			'apps/api/**/*.module.ts',
			'apps/api/**/*.resolver.ts',
			'apps/api/**/*.guard.ts',
			'apps/api/**/*.interceptor.ts',
			'apps/api/**/*.pipe.ts',
			'apps/api/**/*.filter.ts',
			'apps/api/**/*.middleware.ts',
			'apps/api/**/*.gateway.ts'
		],
		rules: {
			'@typescript-eslint/consistent-type-imports': 'off'
		}
	}
);
