const BASE_URL = 'https://quoteom.com';
const SITE_NAME = 'Quoteom';
const DEFAULT_IMAGE = `${BASE_URL}/images/logo.png`;
const TWITTER_HANDLE = '@quoteom';

interface PageMetaOptions {
	title: string;
	description: string;
	path: string;
	image?: string;
}

export function createPageMeta({ title, description, path, image = DEFAULT_IMAGE }: PageMetaOptions) {
	const url = `${BASE_URL}${path}`;

	return [
		{ title },
		{ name: 'description', content: description },

		// Open Graph (Facebook, LinkedIn, Instagram)
		{ property: 'og:title', content: title },
		{ property: 'og:description', content: description },
		{ property: 'og:url', content: url },
		{ property: 'og:image', content: image },
		{ property: 'og:image:alt', content: `${SITE_NAME} — ${title}` },
		{ property: 'og:image:width', content: '1200' },
		{ property: 'og:image:height', content: '630' },

		// Twitter / X
		{ name: 'twitter:title', content: title },
		{ name: 'twitter:description', content: description },
		{ name: 'twitter:image', content: image },
		{ name: 'twitter:image:alt', content: `${SITE_NAME} — ${title}` },
		{ name: 'twitter:site', content: TWITTER_HANDLE }
	];
}
