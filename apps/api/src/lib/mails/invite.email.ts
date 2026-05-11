import dedent from 'dedent';

interface InviteEmail {
	subject: string;
	html: string;
	text: string;
}

export function buildInviteEmail(input: { url: string; organizationName: string }): InviteEmail {
	const { url, organizationName } = input;
	const subject = `Uitnodiging: ${organizationName} op Quoteom`;

	const text = dedent`
		Je bent uitgenodigd voor ${organizationName} op Quoteom.

		Accepteer de uitnodiging via deze link:

		${url}

		Deze link verloopt over 7 dagen.
	`;

	const html = dedent`
		<!DOCTYPE html>
		<html lang="nl">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>${subject}</title>
			</head>
			<body style="margin: 0; padding: 0; background: #fafaf7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #0f172a;">
				<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #fafaf7; padding: 40px 16px;">
					<tr>
						<td align="center">
							<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="480" style="max-width: 480px; width: 100%; background: #ffffff; border: 1px solid #e7e5e0; border-radius: 8px;">
								<tr>
									<td style="padding: 40px;">
										<h1 style="margin: 0 0 16px; font-family: 'Playfair Display', Georgia, 'Times New Roman', serif; font-size: 28px; font-weight: 600; letter-spacing: -0.02em; color: #0f172a;">
											Welkom bij ${organizationName}
										</h1>
										<p style="margin: 0 0 24px; font-size: 15px; line-height: 1.5; color: #475569;">
											Je bent uitgenodigd om bij <strong>${organizationName}</strong> op Quoteom samen te werken. Klik op de knop hieronder om je uitnodiging te accepteren.
										</p>
										<table role="presentation" cellpadding="0" cellspacing="0" border="0">
											<tr>
												<td style="background: #1e293b; border-radius: 6px;">
													<a href="${url}" style="display: inline-block; padding: 12px 28px; color: #ffffff; text-decoration: none; font-weight: 500; font-size: 15px;">Uitnodiging accepteren</a>
												</td>
											</tr>
										</table>
										<p style="margin: 28px 0 0; font-size: 13px; line-height: 1.5; color: #64748b;">
											Of kopieer deze link in je browser:
										</p>
										<p style="margin: 8px 0 0; font-size: 12px; line-height: 1.4; color: #64748b; word-break: break-all;">
											<a href="${url}" style="color: #d97706; text-decoration: none;">${url}</a>
										</p>
										<hr style="margin: 32px 0; border: 0; border-top: 1px solid #e7e5e0;" />
										<p style="margin: 0; font-size: 13px; line-height: 1.5; color: #64748b;">
											Deze uitnodiging verloopt over 7 dagen. Heb je deze e-mail niet verwacht? Dan kun je hem negeren.
										</p>
									</td>
								</tr>
							</table>
							<p style="margin: 24px 0 0; font-size: 12px; line-height: 1.4; color: #94a3b8;">
								Quoteom &middot; offerte management voor MKB
							</p>
						</td>
					</tr>
				</table>
			</body>
		</html>
	`;

	return { subject, html, text };
}
