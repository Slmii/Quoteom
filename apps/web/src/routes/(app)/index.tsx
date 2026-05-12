import { createPageMeta } from '@/lib/createPageMeta';
import { useSignOut } from '@/lib/queries/auth.queries';
import { myMembershipQueryOptions } from '@/lib/queries/team.queries';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Paper from '@mui/material/Paper';
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
	loader: ({ context }) => context.queryClient.ensureQueryData(myMembershipQueryOptions),
	component: HomePage
});

function HomePage() {
	const navigate = useNavigate();
	const { session } = Route.useRouteContext();
	const { data: me } = useSuspenseQuery(myMembershipQueryOptions);
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

				<Box>
					<Typography variant='body1' sx={{ mb: 1 }}>
						Signed in as <strong>{user.email}</strong>
					</Typography>
					<Typography variant='body2' color='text.secondary' sx={{ mb: 4 }}>
						Active organization: <code>{user.organizationId ?? '— no active organization —'}</code>
					</Typography>

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
				</Box>
			</Paper>
		</Container>
	);
}
