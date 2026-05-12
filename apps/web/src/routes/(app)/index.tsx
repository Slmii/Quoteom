import { createPageMeta } from '@/lib/createPageMeta';
import { useSignOut } from '@/lib/queries/auth.queries';
import {
	myMembershipQueryOptions,
	myOrganizationsQueryOptions,
	useSwitchOrganization
} from '@/lib/queries/team.queries';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';

export const Route = createFileRoute('/(app)/')({
	head: () => {
		return {
			meta: createPageMeta({
				title: 'Quoteom',
				description: 'Quote management for SMBs',
				path: '/'
			})
		};
	},
	loader: ({ context }) =>
		Promise.all([
			context.queryClient.ensureQueryData(myMembershipQueryOptions),
			context.queryClient.ensureQueryData(myOrganizationsQueryOptions)
		]),
	component: HomePage
});

function HomePage() {
	const navigate = useNavigate();
	const { session } = Route.useRouteContext();
	const { data: me } = useSuspenseQuery(myMembershipQueryOptions);
	const { data: organizations } = useSuspenseQuery(myOrganizationsQueryOptions);
	const switchOrganization = useSwitchOrganization();
	const signOut = useSignOut();

	const user = session?.user;
	if (!user) {
		return null;
	}

	const isOwner = me.role === 'OWNER';

	return (
		<Container maxWidth='sm' sx={{ py: 8 }}>
			<Paper variant='outlined' sx={{ p: 5 }}>
				<Typography variant='h1' sx={{ fontSize: 32, mb: 1 }}>
					Quoteom
				</Typography>
				<Typography variant='body2' color='text.secondary' sx={{ mb: 4 }}>
					Quote management for SMBs
				</Typography>

				<Stack spacing={2}>
					<Typography variant='body1' sx={{ mb: 1 }}>
						Signed in as <strong>{user.email}</strong>
					</Typography>

					<TextField
						select
						size='small'
						label='Active organization'
						value={me.organizationId}
						onChange={e => switchOrganization.mutate(e.target.value)}
						disabled={switchOrganization.isPending}
						sx={{ mb: 4, minWidth: 240 }}
					>
						{organizations.map(m => (
							<MenuItem key={m.organizationId} value={m.organizationId}>
								{m.organization.name} · {m.role.toLowerCase()}
							</MenuItem>
						))}
					</TextField>

					<Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
						<Button variant='contained' onClick={() => navigate({ to: '/team' })}>
							Team
						</Button>
						{isOwner && (
							<Button variant='contained' onClick={() => navigate({ to: '/billing' })}>
								Billing
							</Button>
						)}
						<Button variant='outlined' onClick={() => signOut.mutate()} disabled={signOut.isPending}>
							{signOut.isPending ? 'Signing out...' : 'Sign out'}
						</Button>
					</Box>
				</Stack>
			</Paper>
		</Container>
	);
}
