import { WrapperApiError } from '@/lib/api/client';
import { billingStatusQueryOptions } from '@/lib/queries/billing.queries';
import {
	invitationsQueryOptions,
	membershipsQueryOptions,
	myMembershipQueryOptions,
	useCreateInvitation,
	useRevokeInvitation,
	type MembershipRole
} from '@/lib/queries/team.queries';
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

	const [email, setEmail] = useState('');
	const [role, setRole] = useState<MembershipRole>('MEMBER');

	const isOwner = me.role === 'OWNER';
	const isTrial = status.state === 'local_trial' || status.state === 'trialing';
	const seatsTaken = memberships.length + invitations.length;
	const trialCapReached = isTrial && seatsTaken >= status.seats.included;

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
					{memberships.map(m => (
						<ListItem key={m.id} disableGutters>
							<ListItemText
								primary={m.user.name ?? m.user.email}
								secondary={m.user.name ? m.user.email : null}
							/>
							<Chip size='small' label={m.role} variant='outlined' />
						</ListItem>
					))}
				</List>

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
										isOwner ? (
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

				{isOwner ? (
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
				) : (
					<Typography variant='caption' color='text.secondary'>
						Only the organization owner can invite teammates.
					</Typography>
				)}
			</Paper>
		</Container>
	);
}

function formatEuros(cents: number): string {
	const whole = Math.floor(cents / 100);
	const remainder = cents % 100;
	return remainder === 0 ? `€${whole}` : `€${whole}.${remainder.toString().padStart(2, '0')}`;
}
