import { signInWithOAuth, useSignInWithEmail } from '@/lib/queries/auth.queries';
import type { OAuthProviderId } from '@quoteom/shared';
import { type SignInForm, SignInSchema } from '@/lib/schemas/auth.schema';
import { zodResolver } from '@hookform/resolvers/zod';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { createFileRoute, Link as RouterLink, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

export const Route = createFileRoute('/(auth)/sign-in')({
	component: SignInPage
});

function SignInPage() {
	const [loadingProvider, setLoadingProvider] = useState<OAuthProviderId | null>(null);

	const navigate = useNavigate();
	const signIn = useSignInWithEmail();

	const form = useForm<SignInForm>({
		resolver: zodResolver(SignInSchema),
		defaultValues: { email: '' }
	});

	const onSubmit = form.handleSubmit(async ({ email }) => {
		await signIn.mutateAsync(email);
		navigate({ to: '/verify-request', search: { email } });
	});

	const handleOAuth = async (providerId: OAuthProviderId) => {
		setLoadingProvider(providerId);
		await signInWithOAuth(providerId);
	};

	const oauthBusy = loadingProvider !== null;

	return (
		<Container maxWidth='xs' sx={{ py: 8 }}>
			<Paper variant='outlined' sx={{ p: 5 }}>
				<Typography variant='h1' sx={{ fontSize: 28, mb: 1 }}>
					Sign in
				</Typography>
				<Typography variant='body2' color='text.secondary' sx={{ mb: 3 }}>
					Continue with Google or Microsoft, or use a magic link.
				</Typography>

				<Stack spacing={1.5}>
					<Button
						variant='outlined'
						fullWidth
						size='large'
						disabled={oauthBusy || signIn.isPending}
						onClick={() => handleOAuth('google')}
					>
						{loadingProvider === 'google' ? 'Redirecting...' : 'Sign in with Google'}
					</Button>
					<Button
						variant='outlined'
						fullWidth
						size='large'
						disabled={oauthBusy || signIn.isPending}
						onClick={() => handleOAuth('microsoft-entra-id')}
					>
						{loadingProvider === 'microsoft-entra-id' ? 'Redirecting...' : 'Sign in with Microsoft'}
					</Button>
				</Stack>

				<Divider sx={{ my: 3 }}>
					<Typography variant='caption' color='text.secondary'>
						or use email
					</Typography>
				</Divider>

				<Box component='form' onSubmit={onSubmit} noValidate>
					<TextField
						{...form.register('email')}
						type='email'
						label='Email address'
						autoComplete='email'
						fullWidth
						margin='normal'
						error={!!form.formState.errors.email}
						helperText={form.formState.errors.email?.message}
						disabled={oauthBusy}
					/>

					{signIn.isError && (
						<Alert severity='error' sx={{ mt: 2 }}>
							Something went wrong. Please try again.
						</Alert>
					)}

					<Button
						type='submit'
						variant='contained'
						fullWidth
						size='large'
						disabled={signIn.isPending || oauthBusy}
						sx={{ mt: 3 }}
					>
						{signIn.isPending ? 'Sending...' : 'Send magic link'}
					</Button>
				</Box>

				<Typography variant='body2' color='text.secondary' sx={{ mt: 3, textAlign: 'center' }}>
					Don't have an account?{' '}
					<Link component={RouterLink} to='/sign-up'>
						Create one
					</Link>
				</Typography>
			</Paper>
		</Container>
	);
}
