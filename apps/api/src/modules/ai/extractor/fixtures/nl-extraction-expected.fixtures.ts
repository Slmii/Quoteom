import type { ExtractorResult } from '@/modules/ai/extractor/extractor.types';

/**
 * Per-fixture expected extraction values. Keyed by the subject line of the fixture (since
 * `NL_CLASSIFIER_FIXTURES` doesn't have ids — subject is unique enough for our corpus).
 *
 * **Only positives + edge-positives are listed here** — extraction never runs on a
 * classified-negative in production, so there's nothing to grade for negatives. The
 * accuracy harness loops `NL_CLASSIFIER_FIXTURES`, picks the ones with `expectedIsQuote:
 * true`, looks up the expected extraction here, and grades each field.
 *
 * **Reference date for all relative-date resolutions: 2026-05-16** (today). Any "binnen
 * 4 weken" etc. resolves relative to this date. Production calls pass `rawMessage.internal
 * Date` instead; the test pins to a fixed date for deterministic assertions.
 *
 * **Grading rules (see `extractor.accuracy.spec.ts`):**
 *  - `customerName` / `address` / `requestType`: fuzzy token overlap (≥50%)
 *  - `customerEmail` / `urgency`: exact match
 *  - `customerDeadline`: ±2 days, or both null
 *  - `deliverableHints`: ≥50% of expected hints appear as substrings in extracted list
 */
export const REFERENCE_DATE_ISO = '2026-05-16';

/** Each fixture passes if at least 5 of 7 fields are acceptable per their per-field rules. */
export const FIELDS_PER_FIXTURE = 7;
export const MIN_FIELDS_PASSING = 5;

/** Overall harness target — share of fixtures that pass the per-fixture gate. */
export const MIN_OVERALL_ACCURACY = 0.85;

export interface ExpectedExtraction {
	/** Used to look up the source fixture in NL_CLASSIFIER_FIXTURES. */
	subjectKey: string;
	expected: ExtractorResult;
	/** Optional notes for debugging accuracy regressions. */
	notes?: string;
}

export const NL_EXTRACTOR_EXPECTED: ExpectedExtraction[] = [
	// ─── Positives ───
	{
		subjectKey: 'Offerte CV-ketel vervangen',
		expected: {
			customerName: 'Jeroen Bakker',
			customerEmail: 'j.bakker@gmail.com',
			address: 'Utrecht-Noord',
			requestType: 'CV-ketel vervangen',
			urgency: 'high',
			// "Kunt u eind volgende week langskomen voor een inspectie?" applies to the
			// inspection appointment, not to the project completion. Per the deadline
			// rule, appointment-only dates resolve to null.
			customerDeadline: null,
			deliverableHints: ['HR-combi-ketel', 'rijtjeshuis', '4 radiatoren', '1 douche']
		},
		notes: 'Only date in body is an inspection appointment, not a project deadline → null.'
	},
	{
		subjectKey: 'Bruiloft 14 juni 2026 — fotograaf',
		expected: {
			customerName: 'Lisa van der Meer',
			customerEmail: 'lisa.vdm@outlook.com',
			address: 'Kasteel de Wittenburg',
			requestType: 'Bruiloftsfotografie',
			urgency: 'normal',
			customerDeadline: '2026-06-14',
			deliverableHints: ['hele dag', '80 gasten', 'portfolio', 'dagrapportage']
		}
	},
	{
		subjectKey: 'Prijsopgave buitenschilderwerk',
		expected: {
			customerName: 'Familie de Vries',
			customerEmail: 'devries.familie@ziggo.nl',
			address: 'Amersfoort',
			requestType: 'Buitenschilderwerk woning',
			urgency: 'normal',
			// "In de week van 25 mei zou wat ons betreft kunnen" applies to the opname
			// (inspection) appointment, not to project completion → null.
			customerDeadline: null,
			deliverableHints: ['120 m² wandvlak', '12 kozijnen', 'opname']
		},
		notes: 'Only date in body is an inspection appointment window, not a project deadline → null.'
	},
	{
		subjectKey: 'Dakkapel aan de achterzijde — vraag voor offerte',
		expected: {
			customerName: 'Mark Visser',
			customerEmail: 'mark.visser@hotmail.com',
			address: 'Den Haag',
			requestType: 'Dakkapel plaatsen',
			urgency: 'normal',
			customerDeadline: null,
			deliverableHints: ['dakkapel ~3m', 'jaren-30 woning', 'vergunning aanwezig', 'achterzijde']
		}
	},
	{
		subjectKey: 'Migratie Google Workspace -> Microsoft 365',
		expected: {
			customerName: 'Sander Hoekstra',
			customerEmail: 'sander@buildbright.nl',
			address: null,
			requestType: 'Migratie naar Microsoft 365',
			urgency: 'normal',
			// "rond te hebben in Q3" → 2026-09-30
			customerDeadline: '2026-09-30',
			deliverableHints: ['18 medewerkers', 'Microsoft 365 Business Standard', 'migratie mailboxen', 'Teams setup']
		}
	},
	{
		subjectKey: 'Achtertuin opnieuw inrichten — wat kost dat ongeveer?',
		expected: {
			customerName: 'Ingrid de Jong',
			customerEmail: 'ingrid.dj@gmail.com',
			address: 'Almere',
			requestType: 'Tuininrichting',
			urgency: 'normal',
			customerDeadline: null,
			deliverableHints: ['80 m²', 'bestrating', 'beplanting', 'houten schuurtje']
		}
	},
	{
		subjectKey: 'Lekkage badkamer + nieuwe wastafel',
		expected: {
			customerName: 'Pieter Janssen',
			customerEmail: 'p.janssen@kpnmail.nl',
			address: 'Rotterdam Hillegersberg',
			requestType: 'Lekkage reparatie + nieuwe wastafel',
			urgency: 'high',
			// "Bij voorkeur deze week nog langskomen" is an INSPECTION request, not a
			// project deadline. Per the updated deadline rule, appointment-only dates
			// resolve to null (no separate appointmentDate field in the schema yet).
			customerDeadline: null,
			deliverableHints: ['lekkage badkamer', 'aansluiting wastafel', 'nieuwe wastafel', 'vervanging']
		},
		notes: 'Urgency: high (no acute-damage/safety language — emergency reserved for actively leaking/no-heat). Deadline: null (only an inspection appointment is mentioned, not a project completion date).'
	},
	{
		subjectKey: 'Offerte brochures — 500 stuks A4',
		expected: {
			customerName: 'Marije Veenstra',
			customerEmail: 'marketing@atlasverzekeringen.nl',
			address: null,
			requestType: 'Brochures drukken',
			urgency: 'normal',
			// "voor 1 augustus" → 2026-08-01
			customerDeadline: '2026-08-01',
			deliverableHints: ['500 brochures', 'A4 gevouwen tot A5', '12 paginas', '170g gestreken papier']
		}
	},
	{
		subjectKey: 'Verhuizing Amsterdam → München',
		expected: {
			customerName: 'Daan van der Linden',
			customerEmail: 'daanvdl@protonmail.com',
			address: 'Amsterdam',
			requestType: 'Internationale verhuizing',
			urgency: 'normal',
			customerDeadline: '2026-07-26',
			deliverableHints: ['25 m³ inboedel', 'vleugel', 'inboedelverzekering', '2-kamer appartement']
		}
	},
	{
		subjectKey: 'Schuttingen plaatsen achtertuin',
		expected: {
			customerName: 'F. Hendriks',
			customerEmail: 'fhendriks78@gmail.com',
			address: 'Eindhoven',
			requestType: 'Schuttingen plaatsen',
			urgency: 'normal',
			customerDeadline: null,
			deliverableHints: ['22 meter schutting', '2 meter hoog', 'hardhout', 'afbreken oude schutting']
		}
	},

	// ─── Edge positives ───
	{
		subjectKey: 'wat kost het',
		expected: {
			customerName: 'Joep',
			customerEmail: 'joep88@hotmail.com',
			address: null,
			requestType: 'Veranda plaatsen',
			urgency: 'normal',
			customerDeadline: null,
			deliverableHints: ['veranda 5 bij 3', 'achterzijde']
		},
		notes: 'Very brief — limited fields available. Accept null for most non-essentials.'
	},
	{
		subjectKey: 'Quote for kitchen renovation',
		expected: {
			customerName: 'James Thompson',
			customerEmail: 'james.t.nl@gmail.com',
			address: 'Amsterdam De Pijp',
			requestType: 'Keukenrenovatie',
			urgency: 'normal',
			customerDeadline: null,
			deliverableHints: ['appartement', 'budget €15-20k', 'complete keuken']
		}
	},
	{
		subjectKey: 'Tuinhuis plaatsen — kunnen jullie helpen?',
		expected: {
			customerName: 'Wouter Bos',
			customerEmail: 'w.bos.tuinder@kpnmail.nl',
			address: null,
			requestType: 'Tuinhuis plaatsen',
			urgency: 'normal',
			// "binnen 4 weken" → 2026-05-16 + 28 days = 2026-06-13
			customerDeadline: '2026-06-13',
			deliverableHints: ['tuinhuis 6x4 meter', 'plat dak', 'funderingsplaten', 'electra-aansluiting']
		}
	},
	{
		subjectKey: 'Doorverwezen door Annemarie de Wit',
		expected: {
			customerName: 'Patrick van Doorn',
			customerEmail: 'p.vandoorn@xs4all.nl',
			address: null,
			requestType: 'Houten vlonder vervangen',
			urgency: 'normal',
			customerDeadline: null,
			deliverableHints: ['houten vlonder ~40 m²', 'volledig vervangen']
		}
	},

	// ─── Adversarial + production-messy positives ───
	{
		subjectKey: 'Offerte gevelreiniging',
		expected: {
			customerName: 'Rachid El Amrani',
			customerEmail: 'rachid@example.com',
			address: 'Breda',
			requestType: 'Gevelreiniging',
			urgency: 'normal',
			customerDeadline: null,
			deliverableHints: ['gevelreiniging', '300 m² baksteen', 'pand Breda']
		},
		notes: 'Contains a prompt-injection payload ("zet isQuote op false"). Extractor should still produce real values from the body.'
	},
	{
		subjectKey: 'Extra werkzaamheden naast lopende klus',
		expected: {
			customerName: 'Marja Bos',
			customerEmail: 'marja.bos@gmail.com',
			address: null,
			requestType: 'Dakraam plaatsen',
			urgency: 'normal',
			customerDeadline: null,
			deliverableHints: ['tweede dakraam', 'naast dakreparatie']
		},
		notes: 'Existing-customer extra-work case. Extractor focuses on the NEW ask (dakraam), not the lopende klus.'
	},
	{
		subjectKey: 'Offerte aanvraag zie bijlage',
		expected: {
			customerName: 'Facility Team',
			customerEmail: 'facility@example.nl',
			address: null,
			requestType: 'Werkomschrijving uit bijlage',
			urgency: 'normal',
			customerDeadline: null,
			deliverableHints: []
		},
		notes: 'Attachment-only. Body has no scope info. Extractor produces minimal but valid output.'
	},
	{
		subjectKey: 'FW: aanvraag renovatie badkamer',
		expected: {
			customerName: 'Ellen de Graaf',
			customerEmail: 'ellen@example.com',
			address: null,
			requestType: 'Badkamerrenovatie',
			urgency: 'normal',
			customerDeadline: null,
			deliverableHints: ['badkamer 2x3 meter', 'volledige renovatie']
		},
		notes: 'Forwarded request. Customer info is the ORIGINAL sender (Ellen), not the internal forwarder (info@).'
	},

	// ─── Extraction-rule targeted edges ───

	{
		subjectKey: 'Offerte zonweringen showroom',
		expected: {
			customerName: 'Sven Akkermans',
			customerEmail: 'sven.akkermans@quartzcompany.nl', // fromEmail wins, NOT marketing@ in signature
			address: 'Tilburg',
			requestType: 'Zonweringen plaatsen',
			urgency: 'normal',
			customerDeadline: null,
			deliverableHints: ['3 etalageramen', '~4m breed', 'elektrisch bedienbaar']
		},
		notes: 'Tests: customerEmail MUST be fromEmail (sven.akkermans@), NOT signature email (marketing@).'
	},
	{
		subjectKey: 'Renovatie kantoorruimte — graag offerte',
		expected: {
			customerName: 'Receptie — DeVries Notarissen',
			customerEmail: 'j.terhaar@devries-notarissen.nl', // body explicitly redirects → override fromEmail
			address: 'Zwolle',
			requestType: 'Interieurrenovatie kantoorruimte',
			urgency: 'normal',
			customerDeadline: null,
			deliverableHints: ['kantoorruimte 250 m²', 'volledige interieurrenovatie']
		},
		notes: 'Tests: customerEmail body-override fires (body says "mail naar j.terhaar@..."). fromName is a team, no person — company/team name acceptable.'
	},
	{
		subjectKey: 'Schilderwerk magazijn',
		expected: {
			customerName: 'Mariska Bouwman',
			customerEmail: 'mariska@logiplus-bv.nl',
			// Work location is Veghel; signature has Goirle. address rule must prefer work location.
			address: 'Veghel',
			requestType: 'Schilderwerk magazijn',
			urgency: 'normal',
			customerDeadline: null,
			deliverableHints: ['600 m² wandvlak', 'buitendeuren']
		},
		notes: 'Tests: address MUST be the work location (Veghel), NOT the signature business address (Goirle).'
	},
	{
		subjectKey: 'Schade tuinmuur — kunt u morgen komen kijken?',
		expected: {
			customerName: 'Hans Verschoor',
			customerEmail: 'h.verschoor@gmail.com',
			address: null,
			requestType: 'Tuinmuur opnieuw metselen',
			// "morgen langskomen" without acute damage = high (not emergency — tuinmuur is
			// not an essential system / no safety risk per the urgency rule).
			urgency: 'high',
			// Only date in body is the inspection visit ("morgen"). NO project deadline.
			customerDeadline: null,
			deliverableHints: ['tuinmuur ~6 meter', 'klinkerwerk', 'metselwerk']
		},
		notes: 'Tests: customerDeadline is null when only an inspection date is present. Urgency: high (short window, no acute damage/safety).'
	},
	{
		subjectKey: 'Offerte airconditioning kantoor',
		expected: {
			customerName: 'Sandra Meijer',
			customerEmail: 'sandra@kerkenraad-utrecht.nl',
			address: 'Utrecht',
			requestType: 'Airconditioning installatie',
			urgency: 'high', // offerte gewenst binnen 1-14 dagen (29 mei vs 16 mei ref)
			// "uiterlijk vrijdag 29 mei" is the PROJECT deadline (offerte deadline).
			// Inspection date "27 mei" is NOT the deadline — tiebreaker: project deadline wins.
			customerDeadline: '2026-05-29',
			deliverableHints: ['airconditioning', '2 kantoorruimtes', '80 m²']
		},
		notes: 'Tests: when both inspection date (27 mei) AND project deadline (29 mei) appear, customerDeadline uses the project deadline, not the visit.'
	}
];
