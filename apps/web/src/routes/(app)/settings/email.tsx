import { billingStatusQueryOptions } from '@/lib/queries/billing.queries';
import {
	EmailKeys,
	gmailMessagesQueryOptions,
	gmailStatusQueryOptions,
	microsoftMessagesQueryOptions,
	microsoftStatusQueryOptions,
	useDisconnectGmail,
	useDisconnectMicrosoft
} from '@/lib/queries/email.queries';
import type { BillingState, GmailMessage, MailboxStatus, MicrosoftMessage } from '@quoteom/shared';
import { myMembershipQueryOptions } from '@/lib/queries/team.queries';
import { EmailSettingsSearchSchema } from '@/lib/schemas/email.schema';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import MuiLink from '@mui/material/Link';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';

export const Route = createFileRoute('/(app)/settings/email')({
	validateSearch: EmailSettingsSearchSchema,
	loader: ({ context }) =>
		Promise.all([
			context.queryClient.ensureQueryData(gmailStatusQueryOptions),
			context.queryClient.ensureQueryData(gmailMessagesQueryOptions),
			context.queryClient.ensureQueryData(microsoftStatusQueryOptions),
			context.queryClient.ensureQueryData(microsoftMessagesQueryOptions),
			context.queryClient.ensureQueryData(billingStatusQueryOptions),
			context.queryClient.ensureQueryData(myMembershipQueryOptions)
		]),
	component: EmailSettingsPage
});

/** Unified row shape — both Gmail and Microsoft messages render the same way. */
interface UnifiedMessage {
	id: string;
	subject: string | null;
	displayFrom: string;
	dateIso: string;
}

function fromGmail(m: GmailMessage): UnifiedMessage {
	return {
		id: m.id,
		subject: m.subject,
		displayFrom: m.from ?? 'unknown sender',
		dateIso: m.internalDate
	};
}

function fromMicrosoft(m: MicrosoftMessage): UnifiedMessage {
	const display = m.fromName
		? m.fromEmail
			? `${m.fromName} <${m.fromEmail}>`
			: m.fromName
		: (m.fromEmail ?? 'unknown sender');
	return {
		id: m.id,
		subject: m.subject,
		displayFrom: display,
		dateIso: m.receivedDateTime
	};
}

function EmailSettingsPage() {
	const navigate = useNavigate();
	const search = Route.useSearch();
	const { data: gmailStatus } = useSuspenseQuery(gmailStatusQueryOptions);
	const { data: gmailMessages } = useSuspenseQuery(gmailMessagesQueryOptions);
	const { data: msStatus } = useSuspenseQuery(microsoftStatusQueryOptions);
	const { data: msMessages } = useSuspenseQuery(microsoftMessagesQueryOptions);
	const { data: billing } = useSuspenseQuery(billingStatusQueryOptions);
	const { data: me } = useSuspenseQuery(myMembershipQueryOptions);

	// Mirror the API's EntitlementGuard set: connect/disconnect will 402 outside this set.
	const billingEntitled = billing.state === 'trialing' || billing.state === 'active' || billing.state === 'past_due';
	const isOwner = me.role === 'OWNER';

	// OAuth callback params (`connected=1`, `error=…`, `adminConsentUrl=…`) are one-shot
	// signals tied to the just-completed handshake. Capture them into local state on mount
	// so the success/error UI and the post-connect polling loop survive — then strip them
	// from the URL so a refresh doesn't keep the alerts visible. `replace: true` keeps the
	// cleaned URL out of the browser history.
	const [oauthFeedback] = useState(() => ({
		connected: search.connected,
		error: search.error,
		adminConsentUrl: search.adminConsentUrl
	}));

	useEffect(() => {
		if (!search.connected && !search.error && !search.adminConsentUrl) {
			return;
		}

		void navigate({ to: '/settings/email', search: {}, replace: true });
		// Run once on mount only — we intentionally do NOT depend on `search` because the
		// effect's job is to clear the URL once, not to react to ongoing changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// `connected=1` only ever fires once per OAuth round-trip; we can't tell from the
	// URL which provider just connected, so the success Alert just says "connected"
	// and the user sees which section is now green.
	const showSuccessAlert = Boolean(oauthFeedback.connected === '1' && (gmailStatus.connected || msStatus.connected));

	return (
		<Container maxWidth='sm' sx={{ py: 8 }}>
			<Paper variant='outlined' sx={{ p: 5 }}>
				<Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
					<Typography variant='h1' sx={{ fontSize: 28 }}>
						Your mailbox
					</Typography>
					<Button size='small' variant='text' onClick={() => navigate({ to: '/' })}>
						← Home
					</Button>
				</Box>
				<Typography variant='body2' color='text.secondary' sx={{ mb: 4 }}>
					Connect your own inbox so Quoteom can read incoming quote requests and send replies on your behalf.
					Each teammate connects their own mailbox.
				</Typography>

				{showSuccessAlert && (
					<Alert severity='success' sx={{ mb: 3 }}>
						Mailbox connected. Most recent messages should appear below within a few seconds.
					</Alert>
				)}

				{oauthFeedback.error === 'microsoft_admin_consent_required' && oauthFeedback.adminConsentUrl ? (
					<AdminConsentAlert adminConsentUrl={oauthFeedback.adminConsentUrl} />
				) : (
					oauthFeedback.error && (
						<Alert severity='error' sx={{ mb: 3 }}>
							The provider returned an error: <strong>{oauthFeedback.error}</strong>. Try connecting
							again.
						</Alert>
					)
				)}

				{!billingEntitled && (
					<Alert
						severity='warning'
						sx={{ mb: 3 }}
						action={
							isOwner ? (
								<Button color='inherit' size='small' onClick={() => navigate({ to: '/billing' })}>
									Subscribe
								</Button>
							) : undefined
						}
					>
						{billingBlockedCopy(billing.state, isOwner)}
					</Alert>
				)}

				<Stack spacing={4}>
					<ProviderPanel
						providerLabel='Gmail'
						connectUrl='/api/email/gmail/connect'
						status={gmailStatus}
						disconnected={gmailMessages.disconnected}
						messages={gmailMessages.messages.map(fromGmail)}
						justConnected={oauthFeedback.connected === '1'}
						billingEntitled={billingEntitled}
						messagesQueryKey={EmailKeys.gmailMessages}
						statusQueryKey={EmailKeys.gmailStatus}
						useDisconnect={useDisconnectGmail}
					/>

					<Divider />

					<ProviderPanel
						providerLabel='Microsoft (Outlook)'
						connectUrl='/api/email/microsoft/connect'
						status={msStatus}
						disconnected={msMessages.disconnected}
						messages={msMessages.messages.map(fromMicrosoft)}
						justConnected={oauthFeedback.connected === '1'}
						billingEntitled={billingEntitled}
						messagesQueryKey={EmailKeys.microsoftMessages}
						statusQueryKey={EmailKeys.microsoftStatus}
						useDisconnect={useDisconnectMicrosoft}
						disconnectNote={
							<>
								Use <strong>Disconnect</strong> above to revoke our access — that's what stops Quoteom
								from reading your mailbox. To also remove Quoteom from your Microsoft account's app
								list, visit{' '}
								<MuiLink
									href='https://account.microsoft.com/privacy/app-access'
									target='_blank'
									rel='noopener noreferrer'
								>
									account.microsoft.com/privacy
								</MuiLink>{' '}
								— this is optional and doesn't disconnect us on its own.
							</>
						}
					/>
				</Stack>

				<Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 5 }}>
					Quoteom requests read + send scopes only. We never read messages outside your offerteaanvraag flow,
					and the tokens are encrypted at rest.
				</Typography>
			</Paper>
		</Container>
	);
}

interface ProviderPanelProps {
	providerLabel: string;
	connectUrl: string;
	status: MailboxStatus;
	disconnected: boolean;
	messages: UnifiedMessage[];
	justConnected: boolean;
	billingEntitled: boolean;
	messagesQueryKey: readonly unknown[];
	statusQueryKey: readonly unknown[];
	useDisconnect: () => { mutate: () => void; isPending: boolean };
	// Optional caption shown under the Disconnect/Reconnect buttons. Used by the Microsoft
	// panel to nudge users at Entra's user-revoke page since Microsoft offers no
	// programmatic revoke endpoint — clearing the local row removes our access, but the
	// grant itself lingers in the user's Microsoft account until they delete it there.
	disconnectNote?: React.ReactNode;
}

/**
 * One provider section. Owns its own connect/disconnect/reconcile lifecycle. Same shape
 * for Gmail and Microsoft — the only differences are the labels, the connect URL, and
 * the query keys.
 */
function ProviderPanel({
	providerLabel,
	connectUrl,
	status,
	disconnected,
	messages,
	justConnected,
	billingEntitled,
	messagesQueryKey,
	statusQueryKey,
	useDisconnect,
	disconnectNote
}: ProviderPanelProps) {
	const queryClient = useQueryClient();
	const disconnect = useDisconnect();

	// Reconcile the parallel-query race: status + messages run side-by-side; if the
	// token was revoked between them, messages says disconnected while status is stale.
	// Trust the messages signal AND invalidate the status query so it refetches.
	const isConnected = status.connected && !disconnected;
	useEffect(() => {
		if (disconnected && status.connected) {
			void queryClient.invalidateQueries({ queryKey: statusQueryKey });
		}
	}, [disconnected, status.connected, queryClient, statusQueryKey]);

	const handleConnect = () => {
		window.location.href = connectUrl;
	};

	return (
		<Box>
			<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
				<Typography variant='overline' color='text.secondary'>
					{providerLabel}
				</Typography>
				{isConnected ? (
					<Chip size='small' color='success' label='Connected' />
				) : (
					<Chip size='small' color='default' label='Not connected' />
				)}
			</Box>

			{isConnected ? (
				<>
					<Typography variant='body1' sx={{ mb: 0.5 }}>
						Connected as <strong>{status.email}</strong>
					</Typography>
					{status.connectedAt && (
						<Typography variant='body2' color='text.secondary'>
							Linked on {dayjs(status.connectedAt).format('D MMM YYYY')}
						</Typography>
					)}

					<Box sx={{ display: 'flex', gap: 2, mt: 3 }}>
						<Button
							variant='outlined'
							color='error'
							onClick={() => disconnect.mutate()}
							disabled={disconnect.isPending || !billingEntitled}
						>
							{disconnect.isPending ? 'Disconnecting...' : 'Disconnect'}
						</Button>
						<Button variant='outlined' onClick={handleConnect} disabled={!billingEntitled}>
							Reconnect
						</Button>
					</Box>

					{disconnectNote && (
						<Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 1.5 }}>
							{disconnectNote}
						</Typography>
					)}

					<Divider sx={{ my: 3 }} />
					<Typography variant='h2' sx={{ fontSize: 16, mb: 2 }}>
						Recent messages
					</Typography>
					{messages.length === 0 ? (
						<BackfillPlaceholder justConnected={justConnected} messagesQueryKey={messagesQueryKey} />
					) : (
						<>
							<List dense disablePadding>
								{messages.map(m => (
									<MessageRow key={m.id} message={m} />
								))}
							</List>
							<Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 2 }}>
								Showing your {messages.length} most recent messages. Full inbox import runs in the
								background.
							</Typography>
						</>
					)}
				</>
			) : (
				<>
					<Typography variant='body1' sx={{ mb: 2 }}>
						No {providerLabel} mailbox connected yet.
					</Typography>
					<Button variant='contained' size='large' onClick={handleConnect} disabled={!billingEntitled}>
						Connect {providerLabel}
					</Button>
				</>
			)}
		</Box>
	);
}

function BackfillPlaceholder({
	justConnected,
	messagesQueryKey
}: {
	justConnected: boolean;
	messagesQueryKey: readonly unknown[];
}) {
	const queryClient = useQueryClient();
	useEffect(() => {
		if (!justConnected) {
			return;
		}
		const id = setInterval(() => {
			void queryClient.invalidateQueries({ queryKey: messagesQueryKey });
		}, 5_000);
		return () => clearInterval(id);
	}, [justConnected, queryClient, messagesQueryKey]);

	if (justConnected) {
		return (
			<Typography variant='body2' color='text.secondary'>
				Importing your last 90 days... this usually takes under a minute.
			</Typography>
		);
	}

	return (
		<Typography variant='body2' color='text.secondary'>
			No messages yet. New mail will appear here automatically.
		</Typography>
	);
}

function MessageRow({ message }: { message: UnifiedMessage }) {
	return (
		<ListItem disableGutters divider sx={{ py: 1 }}>
			<ListItemText
				primary={message.subject ?? '(no subject)'}
				secondary={
					<>
						<Typography component='span' variant='body2' color='text.secondary'>
							{message.displayFrom}
						</Typography>
						{' · '}
						<Typography component='span' variant='caption' color='text.secondary'>
							{dayjs(message.dateIso).format('D MMM YYYY HH:mm')}
						</Typography>
					</>
				}
			/>
		</ListItem>
	);
}

/**
 * Surfaced when a user in a work tenant tries to connect Microsoft and Entra rejects the
 * request because their admin has disabled user-level consent for Mail.* scopes. The user
 * can't fix this themselves — their IT admin has to approve the app once for the whole
 * tenant. We provide a copyable link they can forward to that admin.
 */
function AdminConsentAlert({ adminConsentUrl }: { adminConsentUrl: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(adminConsentUrl);
			setCopied(true);
			setTimeout(() => setCopied(false), 2500);
		} catch {
			// Clipboard API can fail in older browsers / non-secure contexts; the link is
			// visible in the Alert so the user can copy it manually as a fallback.
			setCopied(false);
		}
	};

	return (
		<Alert severity='warning' sx={{ mb: 3 }}>
			<Typography variant='body2' sx={{ mb: 1, fontWeight: 600 }}>
				Your IT admin needs to approve Quoteom for your organization.
			</Typography>
			<Typography variant='body2' sx={{ mb: 2 }}>
				Microsoft requires a one-time admin approval before anyone in your company can connect their mailbox.
				Forward this link to your IT admin — once they approve, you and your colleagues can connect your Outlook
				mailboxes normally.
			</Typography>
			<Box
				sx={{
					p: 1.25,
					mb: 1.5,
					bgcolor: 'background.default',
					border: 1,
					borderColor: 'divider',
					borderRadius: 1,
					wordBreak: 'break-all',
					fontFamily: 'monospace',
					fontSize: 12
				}}
			>
				{adminConsentUrl}
			</Box>
			<Button size='small' variant='outlined' color='inherit' onClick={handleCopy}>
				{copied ? 'Copied!' : 'Copy link'}
			</Button>
		</Alert>
	);
}

function billingBlockedCopy(state: BillingState, isOwner: boolean): string {
	const ownerSuffix = isOwner ? 'Subscribe to connect a mailbox.' : 'Ask your owner to subscribe.';
	switch (state) {
		case 'none':
			return `You haven't started your trial yet. ${ownerSuffix}`;
		case 'canceled':
			return `Your subscription has been canceled. ${ownerSuffix}`;
		case 'unpaid':
			return `Your subscription is unpaid — update your payment method first. ${ownerSuffix}`;
		case 'paused':
			return `Your subscription is paused. ${isOwner ? 'Resume it to connect a mailbox.' : 'Ask your owner to resume the subscription.'}`;
		case 'incomplete':
			return `Subscription setup is incomplete. ${isOwner ? 'Finish checkout to connect a mailbox.' : 'Ask your owner to finish checkout.'}`;
		case 'incomplete_expired':
			return `Subscription setup expired. ${ownerSuffix}`;
		default:
			return `Your subscription is inactive. ${ownerSuffix}`;
	}
}
