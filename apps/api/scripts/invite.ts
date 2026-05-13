/* eslint-disable no-console */
import '../src/load-env';

import { AppModule } from '../src/app.module';
import { InvitationsService } from '../src/modules/invitations/invitations.service';
import { MembershipRole } from '../src/generated/prisma/client';
import { NestFactory } from '@nestjs/core';

interface ParsedArgs {
	email?: string;
	org?: string;
	role?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = {};
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === '--email') result.email = value;
		if (flag === '--org') result.org = value;
		if (flag === '--role') result.role = value;
	}
	return result;
}

function usage(): never {
	console.error(
		`Usage: pnpm invite --email <email> --org <organizationId> [--role OWNER|MEMBER|EXTERNAL]`
	);
	process.exit(1);
}

function parseRole(input: string | undefined): MembershipRole {
	if (!input) return MembershipRole.MEMBER;
	const upper = input.toUpperCase();
	if (upper in MembershipRole) {
		return MembershipRole[upper as keyof typeof MembershipRole];
	}
	console.error(`Unknown role "${input}". Valid: OWNER, MEMBER, EXTERNAL.`);
	process.exit(1);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.email || !args.org) usage();

	const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
	try {
		const service = app.get(InvitationsService);
		const invitation = await service.create({
			email: args.email,
			organizationId: args.org,
			role: parseRole(args.role)
		});
		console.log(`Invitation created`);
		console.log(`  id:    ${invitation.id}`);
		console.log(`  token: ${invitation.token}`);
		console.log(`  email: ${args.email}`);
		console.log(`  org:   ${args.org}`);
	} finally {
		await app.close();
	}
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
