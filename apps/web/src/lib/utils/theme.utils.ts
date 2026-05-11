import { createTheme, Theme } from '@mui/material/styles';

const fonts = {
	body: '"Inter", system-ui, -apple-system, sans-serif',
	display: '"Playfair Display", "Georgia", serif'
} as const;

export const theme = createTheme({
	typography: {
		fontFamily: fonts.body,
		h1: { fontFamily: fonts.display, fontWeight: 600, letterSpacing: '-0.02em' },
		h2: { fontFamily: fonts.display, fontWeight: 600, letterSpacing: '-0.01em' },
		h3: { fontFamily: fonts.display, fontWeight: 600 },
		h4: { fontFamily: fonts.display, fontWeight: 600 },
		h5: { fontFamily: fonts.display, fontWeight: 600 },
		h6: { fontFamily: fonts.display, fontWeight: 600 },
		button: { textTransform: 'none', fontWeight: 500 }
	},
	components: {
		MuiCssBaseline: {
			styleOverrides: theme => ({
				html: {
					scrollBehavior: 'smooth',
					WebkitFontSmoothing: 'antialiased',
					MozOsxFontSmoothing: 'grayscale',
					overscrollBehavior: 'none',
					margin: 0,
					padding: 0,
					minHeight: '100%' /* Ensure body and html take up full content height */
				}
			})
		}
	}
});

export const transition = (theme: Theme) => {
	return theme.transitions.create('all', {
		duration: 250
	});
};
