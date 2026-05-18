import { DismissReason as PrismaDismissReason } from '@/generated/prisma/enums';
import type { OpportunityDismissReason as WireDismissReason } from '@quoteom/shared';

export const OPPORTUNITY_DISMISS_REASON_TO_WIRE: Record<PrismaDismissReason, WireDismissReason> = {
	[PrismaDismissReason.NOT_A_QUOTE]: 'not_a_quote',
	[PrismaDismissReason.DUPLICATE]: 'duplicate',
	[PrismaDismissReason.SPAM]: 'spam',
	[PrismaDismissReason.OTHER]: 'other'
};

export const OPPORTUNITY_DISMISS_REASON_FROM_WIRE: Record<WireDismissReason, PrismaDismissReason> = {
	not_a_quote: PrismaDismissReason.NOT_A_QUOTE,
	duplicate: PrismaDismissReason.DUPLICATE,
	spam: PrismaDismissReason.SPAM,
	other: PrismaDismissReason.OTHER
};
