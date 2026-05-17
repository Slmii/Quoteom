import { aiUsageQueryOptions } from '@/lib/queries/ai-usage.queries';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { AIUsageRange } from '@quoteom/shared';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';

const SearchSchema = z.object({
	range: z.enum(['today', '7d', '30d', 'all']).default('7d')
});

// Admin allowlist gate lives on the parent `(app)/admin/route.tsx` layout — every
// `/admin/*` route inherits it, so this route only owns its own data loading.
export const Route = createFileRoute('/(app)/admin/ai-usage')({
	validateSearch: SearchSchema,
	loaderDeps: ({ search: { range } }) => ({ range }),
	loader: ({ context, deps }) => context.queryClient.ensureQueryData(aiUsageQueryOptions(deps.range)),
	component: AIUsagePage
});

const RANGE_LABELS: Record<AIUsageRange, string> = {
	today: 'Today',
	'7d': 'Last 7 days',
	'30d': 'Last 30 days',
	all: 'All time'
};

function AIUsagePage() {
	const navigate = useNavigate();
	const { range } = Route.useSearch();
	const { data } = useSuspenseQuery(aiUsageQueryOptions(range));

	const setRange = (next: AIUsageRange) => {
		void navigate({ to: '/admin/ai-usage', search: { range: next } });
	};

	return (
		<Container maxWidth='lg' sx={{ py: 6 }}>
			<Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
				<Typography variant='h1' sx={{ fontSize: 28 }}>
					AI usage
				</Typography>
				<Chip label='dev only' size='small' color='warning' />
			</Box>
			<Typography variant='body2' color='text.secondary' sx={{ mb: 3 }}>
				Aggregated <code>AICall</code> rows. Cost is in USD, computed from each row's prompt + completion tokens
				against the model rates in <code>apps/api/src/modules/ai-usage/pricing.ts</code>. Estimate badge marks
				rows whose model isn't in that table — add it there to get a real number.
			</Typography>

			<ButtonGroup variant='outlined' size='small' sx={{ mb: 3 }}>
				{(Object.keys(RANGE_LABELS) as AIUsageRange[]).map(option => (
					<Button
						key={option}
						variant={option === range ? 'contained' : 'outlined'}
						onClick={() => setRange(option)}
					>
						{RANGE_LABELS[option]}
					</Button>
				))}
			</ButtonGroup>

			<Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 3 }}>
				<SummaryCard label='Total cost (USD)' value={`$${data.summary.totalCostUsd.toFixed(4)}`} />
				<SummaryCard label='Total calls' value={data.summary.totalCalls.toLocaleString('en-US')} />
				<SummaryCard label='Prompt tokens' value={data.summary.totalPromptTokens.toLocaleString('en-US')} />
				<SummaryCard
					label='Completion tokens'
					value={data.summary.totalCompletionTokens.toLocaleString('en-US')}
				/>
			</Stack>

			{data.summary.unpricedModels.length > 0 && (
				<Alert severity='warning' sx={{ mb: 3 }}>
					<strong>{data.summary.unpricedModels.length}</strong> model(s) aren't in the pricing table — costs
					for those rows are conservative estimates. Add them to{' '}
					<code>apps/api/src/modules/ai-usage/pricing.ts</code>:{' '}
					{data.summary.unpricedModels.map(m => (
						<Chip key={m} label={m} size='small' sx={{ ml: 0.5 }} />
					))}
				</Alert>
			)}

			<TableContainer component={Paper} variant='outlined'>
				<Table size='small'>
					<TableHead>
						<TableRow>
							<TableCell>Provider</TableCell>
							<TableCell>Model</TableCell>
							<TableCell>Purpose</TableCell>
							<TableCell>Status</TableCell>
							<TableCell>Org</TableCell>
							<TableCell align='right'>Calls</TableCell>
							<TableCell align='right'>Prompt tokens</TableCell>
							<TableCell align='right'>Completion tokens</TableCell>
							<TableCell align='right'>Cost (USD)</TableCell>
						</TableRow>
					</TableHead>
					<TableBody>
						{data.rows.length === 0 ? (
							<TableRow>
								<TableCell colSpan={9} align='center' sx={{ py: 6, color: 'text.secondary' }}>
									No AI calls in this range.
								</TableCell>
							</TableRow>
						) : (
							data.rows.map((row, index) => (
								<TableRow
									key={`${row.provider}/${row.model}/${row.purpose}/${row.organizationId ?? '∅'}/${row.status}/${index}`}
								>
									<TableCell>{row.provider}</TableCell>
									<TableCell>
										<code>{row.model}</code>
									</TableCell>
									<TableCell>{row.purpose}</TableCell>
									<TableCell>
										<Chip
											label={row.status}
											size='small'
											color={row.status === 'SUCCESS' ? 'success' : 'error'}
											variant='outlined'
										/>
									</TableCell>
									<TableCell>
										<code style={{ fontSize: '0.7rem' }}>
											{row.organizationId?.slice(0, 8) ?? '—'}
										</code>
									</TableCell>
									<TableCell align='right'>{row.callCount.toLocaleString('en-US')}</TableCell>
									<TableCell align='right'>{row.promptTokens.toLocaleString('en-US')}</TableCell>
									<TableCell align='right'>{row.completionTokens.toLocaleString('en-US')}</TableCell>
									<TableCell align='right'>
										${row.costUsd.toFixed(6)}
										{row.costIsEstimate && (
											<Chip label='est' size='small' sx={{ ml: 0.5, fontSize: '0.65rem' }} />
										)}
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</TableContainer>

			<Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 2 }}>
				Window: {new Date(data.rangeStart).toLocaleString()} — {new Date(data.rangeEnd).toLocaleString()}
			</Typography>
		</Container>
	);
}

function SummaryCard({ label, value }: { label: string; value: string }) {
	return (
		<Paper variant='outlined' sx={{ p: 2, flex: 1 }}>
			<Typography variant='caption' color='text.secondary' sx={{ display: 'block' }}>
				{label}
			</Typography>
			<Typography variant='h2' sx={{ fontSize: 22, mt: 0.5 }}>
				{value}
			</Typography>
		</Paper>
	);
}
