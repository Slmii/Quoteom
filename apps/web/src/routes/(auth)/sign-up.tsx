import { WrapperApiError } from '@/lib/api/client';
import { useSignUp } from '@/lib/queries/auth.queries';
import { type SignUpForm, SignUpSchema } from '@/lib/schemas/auth.schema';
import { zodResolver } from '@hookform/resolvers/zod';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { createFileRoute, Link as RouterLink, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';

export const Route = createFileRoute('/(auth)/sign-up')({
	component: SignUpPage
});

function SignUpPage() {
	const navigate = useNavigate();
	const signUp = useSignUp();

	const form = useForm<SignUpForm>({
		resolver: zodResolver(SignUpSchema),
		defaultValues: { email: '', companyName: '' }
	});

	const onSubmit = form.handleSubmit(async ({ email, companyName }) => {
		await signUp.mutateAsync({ email, companyName });
		navigate({ to: '/verify-request', search: { email } });
	});

	const errorMessage =
		signUp.error instanceof WrapperApiError
			? signUp.error.message
			: signUp.error
				? 'Something went wrong. Please try again.'
				: null;

	return (
		<Container maxWidth='xs' sx={{ py: 8 }}>
			<Paper variant='outlined' sx={{ p: 5 }}>
				<Typography variant='h1' sx={{ fontSize: 28, mb: 1 }}>
					Create your account
				</Typography>
				<Typography variant='body2' color='text.secondary' sx={{ mb: 3 }}>
					Start a 14-day free trial. No credit card required.
				</Typography>

				<Box component='form' onSubmit={onSubmit} noValidate>
					<TextField
						{...form.register('companyName')}
						label='Company name'
						autoComplete='organization'
						autoFocus
						fullWidth
						margin='normal'
						error={!!form.formState.errors.companyName}
						helperText={form.formState.errors.companyName?.message}
					/>

					<TextField
						{...form.register('email')}
						type='email'
						label='Work email'
						autoComplete='email'
						fullWidth
						margin='normal'
						error={!!form.formState.errors.email}
						helperText={form.formState.errors.email?.message}
					/>

					{errorMessage && (
						<Alert severity='error' sx={{ mt: 2 }}>
							{errorMessage}
						</Alert>
					)}

					<Button
						type='submit'
						variant='contained'
						fullWidth
						size='large'
						disabled={signUp.isPending}
						sx={{ mt: 3 }}
					>
						{signUp.isPending ? 'Creating account...' : 'Create account'}
					</Button>
				</Box>

				<Typography variant='body2' color='text.secondary' sx={{ mt: 3, textAlign: 'center' }}>
					Already have an account?{' '}
					<Link component={RouterLink} to='/sign-in'>
						Sign in
					</Link>
				</Typography>

				<Typography
					variant='caption'
					color='text.secondary'
					sx={{ display: 'block', mt: 2, textAlign: 'center' }}
				>
					Joining a colleague's team? Ask your owner to invite you from the Team page instead.
				</Typography>
			</Paper>
		</Container>
	);
}
