import { PrismaPg } from '@prisma/adapter-pg';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../.env') });

import { MembershipRole, PrismaClient } from '../src/generated/prisma/client';

const prisma = new PrismaClient({
	adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL })
});

// Fixed UUIDs so re-running the seed is idempotent and you can refer to orgs
// in tests/curl by literal ID.
const ORG_ACME = '00000000-0000-0000-0000-000000000001';
const ORG_BOUW = '00000000-0000-0000-0000-000000000002';

const orgs = [
	{ id: ORG_ACME, name: 'Acme Installaties' },
	{ id: ORG_BOUW, name: 'Bouwbedrijf de Vries' }
] as const;

const users = [
	{ email: 'alice@quoteom.dev', name: 'Alice Owens', currentOrg: ORG_ACME },
	{ email: 'jeroen@quoteom.dev', name: 'Jeroen Bakker', currentOrg: ORG_ACME },
	{ email: 'bart@quoteom.dev', name: 'Bart de Vries', currentOrg: ORG_BOUW },
	{ email: 'sander@quoteom.dev', name: 'Sander van Klink', currentOrg: ORG_ACME }
] as const;

const memberships: ReadonlyArray<{ email: string; orgId: string; role: MembershipRole }> = [
	{ email: 'alice@quoteom.dev', orgId: ORG_ACME, role: MembershipRole.OWNER },
	{ email: 'jeroen@quoteom.dev', orgId: ORG_ACME, role: MembershipRole.MEMBER },
	{ email: 'bart@quoteom.dev', orgId: ORG_BOUW, role: MembershipRole.OWNER },
	// Sander is a freelance bookkeeper helping both orgs — same user, two memberships.
	{ email: 'sander@quoteom.dev', orgId: ORG_ACME, role: MembershipRole.EXTERNAL },
	{ email: 'sander@quoteom.dev', orgId: ORG_BOUW, role: MembershipRole.EXTERNAL }
];

async function main() {
	for (const org of orgs) {
		await prisma.organization.upsert({
			where: { id: org.id },
			update: { name: org.name },
			create: { id: org.id, name: org.name }
		});
	}

	for (const user of users) {
		await prisma.user.upsert({
			where: { email: user.email },
			update: { name: user.name, currentOrganizationId: user.currentOrg },
			create: { email: user.email, name: user.name, currentOrganizationId: user.currentOrg }
		});
	}

	for (const m of memberships) {
		const user = await prisma.user.findUniqueOrThrow({ where: { email: m.email } });
		await prisma.membership.upsert({
			where: { userId_organizationId: { userId: user.id, organizationId: m.orgId } },
			update: { role: m.role },
			create: { userId: user.id, organizationId: m.orgId, role: m.role }
		});
	}

	console.log('\nOrganizations:');
	for (const org of orgs) {
		const count = memberships.filter(m => m.orgId === org.id).length;
		console.log(`  ${org.name} (${org.id}) — ${count} member(s)`);
	}

	console.log('\nUsers:');
	for (const user of users) {
		const orgsForUser = memberships
			.filter(m => m.email === user.email)
			.map(m => orgs.find(o => o.id === m.orgId)?.name);
		console.log(`  ${user.email} — current: ${orgsForUser[0]}, all: ${orgsForUser.join(', ')}`);
	}
}

main()
	.catch(async error => {
		console.error(error);
		await prisma.$disconnect();
		process.exit(1);
	})
	.then(async () => {
		await prisma.$disconnect();
	});
