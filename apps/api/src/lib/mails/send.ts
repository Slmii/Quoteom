interface SendEmailInput {
	to: string;
	subject: string;
	html: string;
	text: string;
	/**
	 * Message to log in dev when no RESEND_API_KEY is configured.
	 * Typically contains the magic-link URL or invite URL so flows still work locally.
	 */
	devFallbackLog?: string;
}

/**
 * Single chokepoint for outgoing email. Switches automatically:
 *  - With RESEND_API_KEY → POST to Resend's HTTP API.
 *  - Without RESEND_API_KEY → log `devFallbackLog` to console.
 */
export async function sendEmail(input: SendEmailInput): Promise<void> {
	const { to, subject, html, text, devFallbackLog } = input;

	if (!process.env.RESEND_API_KEY) {
		if (devFallbackLog) {
			console.log(`\n  ${devFallbackLog}\n`);
		}
		return;
	}

	const fromAddress = process.env.RESEND_EMAIL_FROM ?? 'onboarding@resend.dev';
	const from = `Quoteom <${fromAddress}>`;

	const response = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ from, to, subject, html, text })
	});

	if (!response.ok) {
		throw new Error(`Resend error: ${await response.text()}`);
	}
}
