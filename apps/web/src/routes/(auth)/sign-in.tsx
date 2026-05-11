import { useSignInWithEmail } from '@/lib/queries/auth.queries';
import { type SignInForm, SignInSchema } from '@/lib/schemas/auth.schema';
import { zodResolver } from '@hookform/resolvers/zod';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';

export const Route = createFileRoute('/(auth)/sign-in')({
	component: SignInPage
});

function SignInPage() {
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

	return (
		<Container maxWidth='xs' sx={{ py: 8 }}>
			<Paper variant='outlined' sx={{ p: 5 }}>
				<Typography variant='h1' sx={{ fontSize: 28, mb: 1 }}>
					Sign in
				</Typography>
				<Typography variant='body2' color='text.secondary' sx={{ mb: 3 }}>
					Enter your email address. We'll send you a magic link to sign in.
				</Typography>

				<Box component='form' onSubmit={onSubmit} noValidate>
					<TextField
						{...form.register('email')}
						type='email'
						label='Email address'
						autoComplete='email'
						autoFocus
						fullWidth
						margin='normal'
						error={!!form.formState.errors.email}
						helperText={form.formState.errors.email?.message}
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
						disabled={signIn.isPending}
						sx={{ mt: 3 }}
					>
						{signIn.isPending ? 'Sending...' : 'Send magic link'}
					</Button>
				</Box>
			</Paper>
		</Container>
	);
}
