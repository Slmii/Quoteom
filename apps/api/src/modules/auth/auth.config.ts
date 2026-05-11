import { PrismaClient } from '@/generated/prisma/client';
import { buildMagicLinkEmail } from '@/lib/mails/magic-link.email';
import { sendEmail } from '@/lib/mails/send';
import type { ExpressAuthConfig } from '@auth/express';
import GoogleProvider from '@auth/express/providers/google';
import MicrosoftEntra from '@auth/express/providers/microsoft-entra-id';
import ResendProvider from '@auth/express/providers/resend';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { PrismaPg } from '@prisma/adapter-pg';

// Auth.js needs the raw PrismaClient (its adapter introspects model names at construction).
// We construct a dedicated instance here rather than reusing PrismaService because the auth
// handler is mounted as Express middleware in main.ts — outside the NestJS DI lifecycle.
// Connection pooling still funnels to the same Postgres instance.
const authPrisma = new PrismaClient({
	adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL })
});

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

// Block Auth.js from auto-creating users. Sign-in is for already-provisioned accounts only;
// new users must arrive via an Invitation (created by Quoteom admin).
const baseAdapter = PrismaAdapter(authPrisma as never);
const adapter: typeof baseAdapter = {
	...baseAdapter,
	createUser: () => {
		throw new Error('User self-signup is disabled. Users must be invited.');
	}
};

const providers: ExpressAuthConfig['providers'] = [
	ResendProvider({
		apiKey: process.env.RESEND_API_KEY ?? 'placeholder',
		from: process.env.RESEND_EMAIL_FROM ?? 'onboarding@resend.dev',
		sendVerificationRequest: async ({ identifier: to, url }) => {
			// First gate: only send to addresses that already have a User row.
			// Unknown addresses silently succeed (no email, no error) so attackers can't
			// enumerate registered accounts.
			const existing = await authPrisma.user.findUnique({ where: { email: to } });
			if (!existing) {
				console.warn(`[auth] Sign-in attempted for unknown email: ${to}`);
				return;
			}

			const { host } = new URL(url);
			const { html, text } = buildMagicLinkEmail(url);

			await sendEmail({
				to,
				subject: `Sign in to ${host}`,
				html,
				text,
				devFallbackLog: `Magic link for ${to}:\n  ${url}`
			});
		}
	})
];

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
	providers.push(
		GoogleProvider({
			clientId: process.env.GOOGLE_CLIENT_ID,
			clientSecret: process.env.GOOGLE_CLIENT_SECRET
		})
	);
}

if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
	providers.push(
		MicrosoftEntra({
			clientId: process.env.MICROSOFT_CLIENT_ID,
			clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
			issuer: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID ?? 'common'}/v2.0`
		})
	);
}

export const authConfig: ExpressAuthConfig = {
	adapter,
	trustHost: true,
	session: { strategy: 'jwt' },
	providers,
	callbacks: {
		// Auth.js defaults post-signin redirects to the auth handler's own origin (the API,
		// which has nothing at `/`). Rewrite same-origin redirects to point at the web app.
		async redirect({ url, baseUrl }) {
			if (url.startsWith(baseUrl)) {
				return url.replace(baseUrl, WEB_ORIGIN);
			}
			if (url.startsWith('/')) {
				return `${WEB_ORIGIN}${url}`;
			}
			if (url.startsWith(WEB_ORIGIN)) {
				return url;
			}
			return WEB_ORIGIN;
		},
		// On sign-in, enrich the JWT with userId + currentOrganizationId so we don't have to
		// hit the DB on every request. On subsequent requests `user` is undefined and we just
		// pass the existing token through.
		async jwt({ token, user }) {
			if (user?.email) {
				const dbUser = await authPrisma.user.findUnique({
					where: { email: user.email },
					select: { id: true, currentOrganizationId: true }
				});
				if (dbUser) {
					token.userId = dbUser.id;
					token.organizationId = dbUser.currentOrganizationId;
				}
			}
			return token;
		},
		// Copy JWT-side custom claims to the session payload exposed via /api/auth/session.
		async session({ session, token }) {
			if (token.userId) {
				session.user = {
					...session.user,
					id: token.userId as string,
					organizationId: (token.organizationId as string | null) ?? null
				};
			}
			return session;
		}
	},
	pages: {
		// Browser flows redirect to the web app; the web app calls back to /api/auth/*.
		signIn: '/sign-in',
		verifyRequest: '/verify-request',
		error: '/sign-in'
	}
};

declare module '@auth/core/types' {
	interface Session {
		user: {
			id: string;
			email?: string | null;
			name?: string | null;
			image?: string | null;
			organizationId: string | null;
		};
	}
}

declare module '@auth/core/jwt' {
	interface JWT {
		userId?: string;
		organizationId?: string | null;
	}
}
