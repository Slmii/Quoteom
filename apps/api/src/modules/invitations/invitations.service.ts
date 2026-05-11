import { MembershipRole } from '@/generated/prisma/client';
import { buildInviteEmail } from '@/lib/mails/invite.email';
import { sendEmail } from '@/lib/mails/send';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

const INVITATION_TTL_DAYS = 7;
const INVITATION_TOKEN_BYTES = 32;

interface CreateInvitationInput {
	email: string;
	organizationId: string;
	role?: MembershipRole;
}

export interface AcceptResult {
	userId: string;
	email: string;
	organizationId: string;
	organizationName: string;
}

@Injectable()
export class InvitationsService {
	constructor(private readonly prisma: PrismaService) {}

	async create(input: CreateInvitationInput): Promise<{ id: string; token: string }> {
		const organization = await this.prisma.organization.findUnique({
			where: { id: input.organizationId }
		});
		if (!organization) {
			throw new NotFoundException(`Organization ${input.organizationId} not found`);
		}

		const token = randomBytes(INVITATION_TOKEN_BYTES).toString('hex');
		const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

		const invitation = await this.prisma.invitation.create({
			data: {
				token,
				email: input.email,
				organizationId: input.organizationId,
				role: input.role ?? MembershipRole.MEMBER,
				expiresAt
			}
		});

		const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
		const url = `${webOrigin}/accept-invite?token=${token}`;
		const { subject, html, text } = buildInviteEmail({
			url,
			organizationName: organization.name
		});

		await sendEmail({
			to: input.email,
			subject,
			html,
			text,
			devFallbackLog: `Invite for ${input.email} to ${organization.name}:\n  ${url}`
		});

		return { id: invitation.id, token: invitation.token };
	}

	async accept(token: string): Promise<AcceptResult> {
		const invitation = await this.prisma.invitation.findUnique({
			where: { token },
			include: { organization: true }
		});

		if (!invitation) {
			throw new NotFoundException('Invitation not found');
		}
		if (invitation.acceptedAt) {
			throw new ConflictException('Invitation has already been accepted');
		}
		if (invitation.expiresAt < new Date()) {
			throw new GoneException('Invitation has expired');
		}

		return this.prisma.$transaction(async tx => {
			const user = await tx.user.upsert({
				where: { email: invitation.email },
				update: {},
				create: {
					email: invitation.email,
					currentOrganizationId: invitation.organizationId
				}
			});

			// First-time user with no active org → pin to this one.
			if (!user.currentOrganizationId) {
				await tx.user.update({
					where: { id: user.id },
					data: { currentOrganizationId: invitation.organizationId }
				});
			}

			await tx.membership.upsert({
				where: {
					userId_organizationId: {
						userId: user.id,
						organizationId: invitation.organizationId
					}
				},
				update: {},
				create: {
					userId: user.id,
					organizationId: invitation.organizationId,
					role: invitation.role
				}
			});

			await tx.invitation.update({
				where: { id: invitation.id },
				data: { acceptedAt: new Date() }
			});

			return {
				userId: user.id,
				email: invitation.email,
				organizationId: invitation.organizationId,
				organizationName: invitation.organization.name
			};
		});
	}
}
