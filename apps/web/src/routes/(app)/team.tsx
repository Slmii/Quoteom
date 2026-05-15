import { WrapperApiError } from '@/lib/api/client';
import { billingStatusQueryOptions } from '@/lib/queries/billing.queries';
import {
	invitationsQueryOptions,
	membershipsQueryOptions,
	myMembershipQueryOptions,
	useCreateInvitation,
	useRemoveMember,
	useRevokeInvitation
} from '@/lib/queries/team.queries';
import type { BillingState, MembershipRole } from '@quoteom/shared';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useState } from 'react';

// OWNER is omitted intentionally — every org has exactly one owner, set at org creation.
// Ownership transfer (if we ever build it) is a separate flow, not via invitation.
const ROLE_OPTIONS: ReadonlyArray<{ value: MembershipRole; label: string; hint: string }> = [
	{ value: 'MEMBER', label: 'Member', hint: 'Standard teammate — can use the app day-to-day.' },
	{ value: 'EXTERNAL', label: 'External', hint: 'Limited access for contractors or clients.' }
];

export const Route = createFileRoute('/(app)/team')({
	loader: ({ context }) => {
		return Promise.all([
			context.queryClient.ensureQueryData(membershipsQueryOptions),
			context.queryClient.ensureQueryData(invitationsQueryOptions),
			context.queryClient.ensureQueryData(billingStatusQueryOptions),
			context.queryClient.ensureQueryData(myMembershipQueryOptions)
		]);
	},
	component: TeamPage
});

function TeamPage() {
	const { data: memberships } = useSuspenseQuery(membershipsQueryOptions);
	const { data: invitations } = useSuspenseQuery(invitationsQueryOptions);
	const { data: status } = useSuspenseQuery(billingStatusQueryOptions);
	const { data: me } = useSuspenseQuery(myMembershipQueryOptions);

	const navigate = useNavigate();
	const createInvitation = useCreateInvitation();
	const revokeInvitation = useRevokeInvitation();
	const removeMember = useRemoveMember();

	const [email, setEmail] = useState('');
	const [role, setRole] = useState<MembershipRole>('MEMBER');

	const isOwner = me.role === 'OWNER';
	const isTrial = status.state === 'trialing';
	const seatsTaken = memberships.length + invitations.length;
	const trialCapReached = isTrial && seatsTaken >= status.seats.included;
	// Mirror the API's EntitlementGuard set. Any state outside this list will 402 at
	// submission time, so disable the invite form proactively. A brand-new org with
	// state='none' falls into the disabled branch — they need to Checkout first.
	const billingEntitled =
		status.state === 'trialing' || status.state === 'active' || status.state === 'past_due';

	const handleSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		if (!email.trim()) {
			return;
		}
		createInvitation.mutate(
			{ email: email.trim(), role },
			{
				onSuccess: () => {
					setEmail('');
					setRole('MEMBER');
				}
			}
		);
	};

	const inviteError = createInvitation.error;
	const isTrialSeatLimit = inviteError instanceof WrapperApiError && inviteError.apiCode === 'trial_seat_limit';

	return (
		<Container maxWidth='sm' sx={{ py: 8 }}>
			<Paper variant='outlined' sx={{ p: 5 }}>
				<Typography variant='h1' sx={{ fontSize: 28, mb: 1 }}>
					Team
				</Typography>
				<Typography variant='body2' color='text.secondary' sx={{ mb: 4 }}>
					{seatsTaken} of {status.seats.included} {isTrial ? 'seats during trial' : 'included seats'}
					{!isTrial && seatsTaken > status.seats.included
						? ` (${seatsTaken - status.seats.included} extra @ ${formatEuros(
								status.seats.overagePerSeatCents
							)}/mo each)`
						: null}
				</Typography>

				<Typography variant='overline' color='text.secondary'>
					Members
				</Typography>
				<List dense disablePadding sx={{ mb: 2 }}>
					{memberships.map(m => {
						// Hide the remove button on the owner's own row (you can't remove yourself,
						// the API would 400) AND on any OWNER row (defensive — server rejects with
						// 409 even if a non-OWNER's owner row was somehow shown to us).
						const canRemove = isOwner && m.role !== 'OWNER' && m.user.id !== me.user.id;
						return (
							<ListItem
								key={m.id}
								disableGutters
								secondaryAction={
									canRemove ? (
										<IconButton
											edge='end'
											size='small'
											aria-label={`Remove ${m.user.email}`}
											disabled={removeMember.isPending}
											onClick={() => {
												if (window.confirm(`Remove ${m.user.email} from the organization?`)) {
													removeMember.mutate(m.user.id);
												}
											}}
										>
											×
										</IconButton>
									) : undefined
								}
							>
								<ListItemText
									primary={m.user.name ?? m.user.email}
									secondary={m.user.name ? m.user.email : null}
									sx={{ mr: canRemove ? 6 : 2 }}
								/>
								<Chip size='small' label={m.role} variant='outlined' sx={{ mr: canRemove ? 4 : 0 }} />
							</ListItem>
						);
					})}
				</List>

				{removeMember.error && (
					<Alert severity='error' sx={{ mb: 2 }}>
						{removeMember.error instanceof Error
							? removeMember.error.message
							: 'Could not remove member.'}
					</Alert>
				)}

				{invitations.length > 0 && (
					<>
						<Typography variant='overline' color='text.secondary'>
							Pending invitations
						</Typography>
						<List dense disablePadding sx={{ mb: 2 }}>
							{invitations.map(inv => (
								<ListItem
									key={inv.id}
									disableGutters
									secondaryAction={
										isOwner && billingEntitled ? (
											<IconButton
												edge='end'
												size='small'
												aria-label='Revoke'
												disabled={revokeInvitation.isPending}
												onClick={() => revokeInvitation.mutate(inv.id)}
											>
												×
											</IconButton>
										) : undefined
									}
								>
									<ListItemText
										primary={inv.email}
										secondary={`expires ${dayjs(inv.expiresAt).format('D MMM YYYY')}`}
									/>
								</ListItem>
							))}
						</List>
					</>
				)}

				<Divider sx={{ my: 3 }} />

				{trialCapReached && isOwner && (
					<Alert
						severity='info'
						sx={{ mb: 2 }}
						action={
							<Button color='inherit' size='small' onClick={() => navigate({ to: '/billing' })}>
								Subscribe
							</Button>
						}
					>
						You've used all {status.seats.included} trial seats. Subscribe to invite more teammates and pay{' '}
						{formatEuros(status.seats.overagePerSeatCents)}/mo per extra seat.
					</Alert>
				)}

				{trialCapReached && !isOwner && (
					<Alert severity='info' sx={{ mb: 2 }}>
						This org has used all {status.seats.included} trial seats. Ask your owner to subscribe to add
						more teammates.
					</Alert>
				)}

				{isOwner && !billingEntitled && (
					<Alert
						severity='warning'
						sx={{ mb: 2 }}
						action={
							<Button color='inherit' size='small' onClick={() => navigate({ to: '/billing' })}>
								Subscribe
							</Button>
						}
					>
						{billingBlockedCopy(status.state)}
					</Alert>
				)}

				{isOwner && billingEntitled && (
					<>
						<Typography variant='overline' color='text.secondary' sx={{ display: 'block', mb: 1 }}>
							Invite a teammate
						</Typography>

						{isTrialSeatLimit && (
							<Alert severity='warning' sx={{ mb: 2 }}>
								{inviteError instanceof Error ? inviteError.message : 'Trial seat limit reached.'}
							</Alert>
						)}

						{inviteError && !isTrialSeatLimit && (
							<Alert severity='error' sx={{ mb: 2 }}>
								{inviteError instanceof Error ? inviteError.message : 'Could not send invitation.'}
							</Alert>
						)}

						{createInvitation.isSuccess && (
							<Alert severity='success' sx={{ mb: 2 }}>
								Invitation sent.
							</Alert>
						)}

						<Box component='form' onSubmit={handleSubmit}>
							<Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
								<TextField
									type='email'
									size='small'
									fullWidth
									required
									placeholder='teammate@example.com'
									value={email}
									onChange={e => setEmail(e.target.value)}
									disabled={createInvitation.isPending || trialCapReached}
								/>
								<TextField
									select
									size='small'
									value={role}
									onChange={e => setRole(e.target.value as MembershipRole)}
									disabled={createInvitation.isPending || trialCapReached}
									sx={{ minWidth: 140 }}
								>
									{ROLE_OPTIONS.map(option => (
										<MenuItem key={option.value} value={option.value}>
											{option.label}
										</MenuItem>
									))}
								</TextField>
								<Button
									type='submit'
									variant='contained'
									disabled={createInvitation.isPending || trialCapReached || !email.trim()}
									sx={{ minWidth: 'fit-content' }}
								>
									{createInvitation.isPending ? 'Sending...' : 'Send invite'}
								</Button>
							</Stack>
							<Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 1 }}>
								{ROLE_OPTIONS.find(o => o.value === role)?.hint}
							</Typography>
						</Box>
					</>
				)}

				{!isOwner && (
					<Typography variant='caption' color='text.secondary'>
						Only the organization owner can invite teammates.
					</Typography>
				)}
			</Paper>
		</Container>
	);
}

function billingBlockedCopy(state: BillingState): string {
	switch (state) {
		case 'none':
			return 'Start your 14-day free trial to invite teammates.';
		case 'canceled':
			return 'Your subscription has been canceled. Subscribe again to invite teammates.';
		case 'unpaid':
			return 'Your subscription is unpaid. Update your payment to invite teammates.';
		case 'paused':
			return 'Your subscription is paused. Resume it to invite teammates.';
		case 'incomplete':
			return 'Your subscription setup is incomplete. Complete checkout to invite teammates.';
		case 'incomplete_expired':
			return 'Your subscription setup expired. Subscribe again to invite teammates.';
		default:
			return 'Your subscription is inactive. Subscribe to invite teammates.';
	}
}

function formatEuros(cents: number): string {
	const whole = Math.floor(cents / 100);
	const remainder = cents % 100;
	return remainder === 0 ? `€${whole}` : `€${whole}.${remainder.toString().padStart(2, '0')}`;
}
