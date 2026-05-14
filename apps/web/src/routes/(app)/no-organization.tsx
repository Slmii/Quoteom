import { createPageMeta } from '@/lib/createPageMeta';
import { useSignOut } from '@/lib/queries/auth.queries';
import { myOrganizationsQueryOptions, useSwitchOrganization } from '@/lib/queries/team.queries';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

/**
 * Landing page for an authenticated user who's not currently a member of any organization
 * — e.g. they were the last removed member of their only org. The `(app)/route.tsx`
 * beforeLoad redirects here when `myOrganizations` comes back empty.
 *
 * If the user is in this state but the orgs list IS non-empty (i.e. they have memberships
 * but their `currentOrganizationId` is null for some reason), show a list of orgs to
 * switch into. That's a less common path — primary case is the empty list.
 *
 * No "create a new organization" CTA today: the only `/api/signup` flow requires a fresh
 * email + creates a new User, which doesn't fit a user who's already signed in. A
 * dedicated "create-org-for-existing-user" endpoint can land later as a follow-up.
 */
export const Route = createFileRoute('/(app)/no-organization')({
	head: () => ({
		meta: createPageMeta({
			title: 'No organization · Quoteom',
			description: 'You are not currently part of any organization',
			path: '/no-organization'
		})
	}),
	loader: ({ context }) => context.queryClient.ensureQueryData(myOrganizationsQueryOptions),
	component: NoOrganizationPage
});

function NoOrganizationPage() {
	const { session } = Route.useRouteContext();
	const { data: organizations } = useSuspenseQuery(myOrganizationsQueryOptions);
	const signOut = useSignOut();
	const switchOrganization = useSwitchOrganization();

	const user = session?.user;

	return (
		<Container maxWidth='sm' sx={{ py: 8 }}>
			<Paper variant='outlined' sx={{ p: 5 }}>
				<Typography variant='h1' sx={{ fontSize: 28, mb: 1 }}>
					No active organization
				</Typography>
				<Typography variant='body2' color='text.secondary' sx={{ mb: 4 }}>
					{user?.email ? `You're signed in as ${user.email}, ` : ''}but you're not currently part of any
					organization.
				</Typography>

				{organizations.length === 0 ? (
					<Stack spacing={2}>
						<Typography variant='body1'>
							If you were expecting an invitation, check your email — the link expires after 7 days.
						</Typography>
						<Typography variant='body2' color='text.secondary'>
							Otherwise, sign out and sign up with a different email to start a new organization.
						</Typography>
						<Box>
							<Button variant='outlined' onClick={() => signOut.mutate()} disabled={signOut.isPending}>
								{signOut.isPending ? 'Signing out...' : 'Sign out'}
							</Button>
						</Box>
					</Stack>
				) : (
					<Stack spacing={2}>
						<Typography variant='body1'>Pick an organization to continue:</Typography>
						<Stack spacing={1}>
							{organizations.map(m => (
								<Button
									key={m.organizationId}
									variant='outlined'
									onClick={() => switchOrganization.mutate(m.organizationId)}
									disabled={switchOrganization.isPending}
									sx={{ justifyContent: 'flex-start' }}
								>
									{m.organization.name} · {m.role.toLowerCase()}
								</Button>
							))}
						</Stack>
						<Box>
							<Button variant='text' onClick={() => signOut.mutate()} disabled={signOut.isPending}>
								{signOut.isPending ? 'Signing out...' : 'Sign out instead'}
							</Button>
						</Box>
					</Stack>
				)}
			</Paper>
		</Container>
	);
}
