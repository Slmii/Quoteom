import { useOpenPortal, useStartCheckout } from '@/lib/queries/billing';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/(app)/billing/')({
	component: BillingPage
});

function BillingPage() {
	const startCheckout = useStartCheckout();
	const openPortal = useOpenPortal();

	return (
		<Container maxWidth='sm' sx={{ py: 8 }}>
			<Paper variant='outlined' sx={{ p: 5 }}>
				<Typography variant='h1' sx={{ fontSize: 28, mb: 1 }}>
					Billing
				</Typography>
				<Typography variant='body2' color='text.secondary' sx={{ mb: 4 }}>
					Manage your Quoteom subscription. €149/month after a 14-day free trial.
				</Typography>

				{startCheckout.isError && (
					<Alert severity='error' sx={{ mb: 3 }}>
						{startCheckout.error instanceof Error
							? startCheckout.error.message
							: 'Could not start checkout. Please try again.'}
					</Alert>
				)}
				{openPortal.isError && (
					<Alert severity='error' sx={{ mb: 3 }}>
						{openPortal.error instanceof Error
							? openPortal.error.message
							: 'Could not open the portal. Please try again.'}
					</Alert>
				)}

				<Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
					<Button
						variant='contained'
						size='large'
						onClick={() => startCheckout.mutate()}
						disabled={startCheckout.isPending}
					>
						{startCheckout.isPending ? 'Redirecting...' : 'Start your 14-day trial'}
					</Button>

					<Button
						variant='outlined'
						onClick={() => openPortal.mutate()}
						disabled={openPortal.isPending}
					>
						{openPortal.isPending ? 'Opening...' : 'Manage subscription'}
					</Button>
				</Box>

				<Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 4 }}>
					Pay with card, iDEAL, or SEPA Direct Debit. Cancel any time.
				</Typography>
			</Paper>
		</Container>
	);
}
