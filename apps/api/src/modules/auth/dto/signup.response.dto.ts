import type { SignupResponse } from '@quoteom/shared';

export class SignupResponseDto implements SignupResponse {
	ok!: boolean;
	/** Normalized email — pass this to the Auth.js signin/resend call to trigger the magic link. */
	email!: string;
}
