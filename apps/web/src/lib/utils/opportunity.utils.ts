import type { Opportunity, OpportunityDismissReason, OpportunityStatus, OpportunityUrgency } from '@quoteom/shared';

/**
 * Display constants + small helpers for opportunity rows. Centralized so the upcoming
 * detail view (W5.4), inline status changes elsewhere, dashboard summary cards, etc.
 * all render the same labels + colors as the list page.
 *
 * Dutch-first per `[[project-launch-scope]]`; en/de/fr alternatives will swap these maps
 * once `Organization.locale` lands (D21).
 */

export const OPPORTUNITY_STATUS_LABELS_NL: Record<OpportunityStatus, string> = {
	new: 'Nieuw',
	replied: 'Beantwoord',
	waiting: 'Wachten',
	cold: 'Koud',
	won: 'Gewonnen',
	lost: 'Verloren'
};

export const OPPORTUNITY_URGENCY_COLORS: Record<OpportunityUrgency, string> = {
	emergency: '#8B3A3A',
	high: '#A07A1F',
	normal: '#5C6B73',
	low: '#9CA3AF'
};

/**
 * Sort weight for urgency. Lower = more urgent (sorts first). Used by client-side sort
 * over a loaded page.
 */
export const OPPORTUNITY_URGENCY_RANK: Record<OpportunityUrgency, number> = {
	emergency: 0,
	high: 1,
	normal: 2,
	low: 3
};

/** Background + foreground colors for the status chip. Desaturated per the design brief. */
export const OPPORTUNITY_STATUS_CHIP_COLORS: Record<OpportunityStatus, { bg: string; fg: string }> = {
	new: { bg: '#E0E7EE', fg: '#1B3A5C' },
	replied: { bg: '#D9E5DE', fg: '#2D6A4F' },
	waiting: { bg: '#F4E7CB', fg: '#825F1A' },
	cold: { bg: '#E3E1DC', fg: '#5C6B73' },
	won: { bg: '#CDE3D2', fg: '#1F4D3A' },
	lost: { bg: '#EBD9D9', fg: '#8B3A3A' }
};

/**
 * Client-side sort options for the list page. Server returns newest-first; the other
 * orderings sort the already-loaded page.
 */
export const OPPORTUNITY_SORT_OPTIONS = ['newest_first', 'deadline_soonest', 'urgency'] as const;
export type OpportunitySortOption = (typeof OPPORTUNITY_SORT_OPTIONS)[number];

export const OPPORTUNITY_SORT_LABELS_NL: Record<OpportunitySortOption, string> = {
	newest_first: 'Nieuwste eerst',
	deadline_soonest: 'Deadline (vroegst)',
	urgency: 'Urgentie'
};

/**
 * Sort a loaded page of opportunities client-side. NULL deadlines sort last when
 * sorting by deadline so the user sees concrete deadlines first.
 */
export function sortOpportunities(rows: readonly Opportunity[], sort: OpportunitySortOption): Opportunity[] {
	if (sort === 'newest_first') {
		return [...rows];
	}

	if (sort === 'deadline_soonest') {
		return [...rows].sort((a, b) => {
			const da = a.customerDeadline ? new Date(a.customerDeadline).getTime() : Number.POSITIVE_INFINITY;
			const db = b.customerDeadline ? new Date(b.customerDeadline).getTime() : Number.POSITIVE_INFINITY;
			return da - db;
		});
	}

	return [...rows].sort((a, b) => OPPORTUNITY_URGENCY_RANK[a.urgency] - OPPORTUNITY_URGENCY_RANK[b.urgency]);
}

/**
 * Best human-friendly customer label for an opportunity, falling back through the
 * extracted name → mailbox `From` name → raw email → "Onbekend". The list page, future
 * detail view, and any "recent activity" widget all want the same fallback chain.
 */
export function opportunityCustomerLabel(opportunity: Opportunity): string {
	return opportunity.customerName ?? opportunity.fromName ?? opportunity.fromEmail ?? 'Onbekend';
}

/**
 * W4.6 — Dutch labels for the dismiss reasons surfaced in the kebab modal + the
 * "Toon afgewezen" badge. Kept Dutch-first per `[[project-launch-scope]]` (D21);
 * en/de/fr variants will sit alongside once `Organization.locale` lands.
 */
export const OPPORTUNITY_DISMISS_REASON_LABELS_NL: Record<OpportunityDismissReason, string> = {
	not_a_quote: 'Geen offerteaanvraag',
	duplicate: 'Dubbel',
	spam: 'Spam',
	other: 'Anders'
};
