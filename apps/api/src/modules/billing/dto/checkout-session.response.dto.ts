import type { BillingSyncResponse, CheckoutSessionResponse } from '@quoteom/shared';

export class CheckoutSessionResponseDto implements CheckoutSessionResponse {
	url!: string;
}

export class BillingSyncResponseDto implements BillingSyncResponse {
	ok!: boolean;
	status!: string | null;
}
