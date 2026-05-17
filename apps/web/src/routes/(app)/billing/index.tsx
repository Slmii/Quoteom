import { billingStatusQueryOptions, useOpenPortal, useStartCheckout } from '@/lib/queries/billing.queries';
import type { BillingStatus } from '@quoteom/shared';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';

export const Route = createFileRoute('/(app)/billing/')({
	loader: ({ context }) => context.queryClient.ensureQueryData(billingStatusQueryOptions),
	component: BillingPage
});

function BillingPage() {
	const { data: status } = useSuspenseQuery(billingStatusQueryOptions);
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

				<StatusPanel
					status={status}
					onOpenPortal={() => openPortal.mutate()}
					portalOpening={openPortal.isPending}
				/>

				{(startCheckout.isError || openPortal.isError) && (
					<Alert severity='error' sx={{ mb: 3, mt: 2 }}>
						{startCheckout.error instanceof Error
							? startCheckout.error.message
							: openPortal.error instanceof Error
								? openPortal.error.message
								: 'Something went wrong. Please try again.'}
					</Alert>
				)}

				<Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 3 }}>
					{shouldShowSubscribe(status) && (
						<Button
							variant='contained'
							size='large'
							onClick={() => startCheckout.mutate()}
							disabled={startCheckout.isPending}
						>
							{startCheckout.isPending ? 'Redirecting...' : subscribeLabel(status.state)}
						</Button>
					)}

					{shouldShowManage(status) && (
						<Button
							variant={shouldShowSubscribe(status) ? 'outlined' : 'contained'}
							size={shouldShowSubscribe(status) ? 'medium' : 'large'}
							onClick={() => openPortal.mutate()}
							disabled={openPortal.isPending}
						>
							{openPortal.isPending ? 'Opening...' : portalLabel(status.state)}
						</Button>
					)}
				</Box>

				<Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 4 }}>
					Pay with card, iDEAL, or SEPA Direct Debit. Cancel any time.
				</Typography>
			</Paper>
		</Container>
	);
}

function StatusPanel({
	status,
	onOpenPortal,
	portalOpening
}: {
	status: BillingStatus;
	onOpenPortal: () => void;
	portalOpening: boolean;
}) {
	const { state, currentPeriodEnd, cancelAtPeriodEnd, paymentMethodBrand, paymentMethodLast4 } = status;
	const endDate = currentPeriodEnd ? new Date(currentPeriodEnd) : null;
	const chip = stateChip(state);
	const showCancellationBanner = cancelAtPeriodEnd && endDate !== null;

	return (
		<Box sx={{ mb: 3 }}>
			<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
				<Typography variant='overline' color='text.secondary'>
					Current plan
				</Typography>
				<Chip size='small' color={chip.color} label={chip.label} />
			</Box>

			<Typography variant='body1' sx={{ mb: 0.5 }}>
				{primaryLine(state, endDate)}
			</Typography>
			{secondaryLine(state) && (
				<Typography variant='body2' color='text.secondary'>
					{secondaryLine(state)}
				</Typography>
			)}

			{showCancellationBanner && (
				<Alert
					severity='warning'
					sx={{ mt: 2 }}
					action={
						<Button color='inherit' size='small' onClick={onOpenPortal} disabled={portalOpening}>
							{portalOpening ? 'Opening...' : 'Resume'}
						</Button>
					}
				>
					Cancellation scheduled for {formatDate(endDate)}. Resume your subscription before then to keep
					access.
				</Alert>
			)}

			<Divider sx={{ my: 2 }} />
			<SeatsLine seats={status.seats} state={state} />

			{paymentMethodBrand && paymentMethodLast4 && (
				<>
					<Divider sx={{ my: 2 }} />
					<Typography variant='body2' color='text.secondary'>
						Payment method: {formatPaymentMethod(paymentMethodBrand)} ending in {paymentMethodLast4}
					</Typography>
				</>
			)}
		</Box>
	);
}

function SeatsLine({ seats, state }: { seats: BillingStatus['seats']; state: BillingStatus['state'] }) {
	const isTrial = state === 'trialing';
	const isUnsubscribed = state === 'none';
	const overage = Math.max(0, seats.used - seats.included);
	const overageCents = overage * seats.overagePerSeatCents;
	const remaining = Math.max(0, seats.included - seats.used);

	return (
		<Box>
			<Typography variant='body2'>
				<strong>Seats:</strong> {seats.used} used · {seats.included}{' '}
				{isTrial ? 'max during trial' : 'included in base price'}
			</Typography>

			{isUnsubscribed && (
				<Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
					Start your trial to invite teammates. The first {seats.included} seats are included in the base
					price; additional seats are {formatEuros(seats.overagePerSeatCents)}/month each.
				</Typography>
			)}

			{isTrial && (
				<Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
					{remaining > 0
						? `You can invite ${remaining} more teammate${remaining === 1 ? '' : 's'} during the trial. Subscribe to grow past ${seats.included} seats.`
						: `Trial seat limit reached. Subscribe to invite more teammates.`}
				</Typography>
			)}

			{!isTrial && !isUnsubscribed && overage > 0 && (
				<Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
					{overage} extra seat{overage === 1 ? '' : 's'} × {formatEuros(seats.overagePerSeatCents)}/mo ={' '}
					<strong>{formatEuros(overageCents)}/mo overage</strong>
				</Typography>
			)}

			{!isTrial && !isUnsubscribed && overage === 0 && remaining > 0 && (
				<Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
					Invite up to {remaining} more without overage charges.
				</Typography>
			)}
		</Box>
	);
}

function formatEuros(cents: number): string {
	// Deterministic across SSR/client — same reasoning as formatDate.
	const whole = Math.floor(cents / 100);
	const remainder = cents % 100;
	if (remainder === 0) {
		return `€${whole}`;
	}
	return `€${whole}.${remainder.toString().padStart(2, '0')}`;
}

function stateChip(state: BillingStatus['state']): {
	color: 'default' | 'primary' | 'success' | 'warning' | 'error';
	label: string;
} {
	switch (state) {
		case 'none':
			return { color: 'default', label: 'No plan' };
		case 'trialing':
			return { color: 'primary', label: 'Trial' };
		case 'active':
			return { color: 'success', label: 'Active' };
		case 'past_due':
			return { color: 'warning', label: 'Payment failed' };
		case 'paused':
			return { color: 'warning', label: 'Paused' };
		case 'canceled':
		case 'unpaid':
		case 'incomplete_expired':
			return { color: 'error', label: 'Inactive' };
		case 'incomplete':
			return { color: 'warning', label: 'Incomplete' };
	}
}

function primaryLine(state: BillingStatus['state'], endDate: Date | null): string {
	switch (state) {
		case 'none':
			return "You haven't started your trial yet.";
		case 'trialing':
			return `Free trial — first charge on ${formatDate(endDate)}`;
		case 'active':
			return `Subscription active — renews ${formatDate(endDate)}`;
		case 'past_due':
			return "We couldn't collect your last payment.";
		case 'paused':
			return 'Subscription paused.';
		case 'canceled':
			return 'Subscription canceled.';
		case 'unpaid':
			return 'Subscription unpaid.';
		case 'incomplete':
			return 'Subscription setup incomplete.';
		case 'incomplete_expired':
			return 'Subscription setup expired.';
	}
}

function secondaryLine(state: BillingStatus['state']): string | null {
	switch (state) {
		case 'none':
			return 'Start your 14-day free trial. A card is required at signup, but you won’t be charged for 14 days. Cancel any time before then.';
		case 'past_due':
			return 'Update your payment method to keep your subscription active.';
		case 'canceled':
			return 'Subscribe again to restore access.';
		default:
			return null;
	}
}

function formatDate(date: Date | null): string {
	if (!date) {
		return '—';
	}

	// Use dayjs's locale-independent token formatter — `toLocaleDateString` would produce
	// different strings on the SSR server vs. the user's browser, causing hydration drift.
	return dayjs(date).format('D MMM YYYY');
}

function formatPaymentMethod(brand: string): string {
	if (brand === 'card') {
		return 'Card';
	}
	if (brand === 'sepa_debit') {
		return 'SEPA Direct Debit';
	}
	return brand.charAt(0).toUpperCase() + brand.slice(1);
}

const SUBSCRIBE_STATES: ReadonlyArray<BillingStatus['state']> = ['none', 'canceled', 'incomplete_expired', 'unpaid'];

function shouldShowSubscribe(status: BillingStatus): boolean {
	return SUBSCRIBE_STATES.includes(status.state);
}

function shouldShowManage(status: BillingStatus): boolean {
	// Anyone with a Stripe customer record can open the Portal — even canceled customers
	// may want to see past invoices. Only hide it before they've ever subscribed.
	return status.state !== 'none';
}

function subscribeLabel(state: BillingStatus['state']): string {
	if (state === 'none') {
		return 'Start your 14-day free trial';
	}
	return 'Subscribe';
}

// For terminal states the Portal can only show invoice history (no active sub to manage),
// so the label changes to match. Everything else stays "Manage subscription".
function portalLabel(state: BillingStatus['state']): string {
	switch (state) {
		case 'canceled':
		case 'unpaid':
		case 'incomplete_expired':
			return 'View past invoices';
		default:
			return 'Manage subscription';
	}
}
