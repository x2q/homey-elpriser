'use strict';

/**
 * The 40 price zones served by https://elpriser.org/api (the Danish ones through
 * /api/forecast, every other zone through /api/nordic?zone=<key>).
 *
 * KEEP IN SYNC with the zone enum of https://elpriser.org/api/openapi.json;
 * test/zones.test.js compares this table with a recorded copy of that file and
 * `npm run live` compares it with the live one.
 *
 * `tz` is the wall clock the API's "hour" field (0-23) is expressed in:
 *  - the 13 Nordic feed zones (dk, no, se, fi, nl) are all Europe/Copenhagen -
 *    including Finland: the feed floors every slot to the Copenhagen hour;
 *  - every other zone is its own country's wall clock.
 */

const CPH = 'Europe/Copenhagen';

const SOURCE_ENERGY_CHARTS = 'energy_charts';
const SOURCE_ELEXON = 'elexon';

function z(key, tz, en, da, extra = {}) {
  return { key, tz, label: { en, da }, area: null, source: null, latestKnown: false, ...extra };
}

const ZONES = [
  z('dk1', CPH, 'Denmark - DK1 West (Jutland, Funen)', 'Danmark - DK1 Vest (Jylland, Fyn)', { area: 'DK1' }),
  z('dk2', CPH, 'Denmark - DK2 East (Zealand, Bornholm)', 'Danmark - DK2 Øst (Sjælland, Bornholm)', { area: 'DK2' }),
  z('no1', CPH, 'Norway - NO1 Oslo', 'Norge - NO1 Oslo'),
  z('no2', CPH, 'Norway - NO2 Kristiansand', 'Norge - NO2 Kristiansand'),
  z('no3', CPH, 'Norway - NO3 Trondheim', 'Norge - NO3 Trondheim'),
  z('no4', CPH, 'Norway - NO4 Tromsø', 'Norge - NO4 Tromsø'),
  z('no5', CPH, 'Norway - NO5 Bergen', 'Norge - NO5 Bergen'),
  z('se1', CPH, 'Sweden - SE1 Luleå', 'Sverige - SE1 Luleå'),
  z('se2', CPH, 'Sweden - SE2 Sundsvall', 'Sverige - SE2 Sundsvall'),
  z('se3', CPH, 'Sweden - SE3 Stockholm', 'Sverige - SE3 Stockholm'),
  z('se4', CPH, 'Sweden - SE4 Malmö', 'Sverige - SE4 Malmö'),
  z('fi', CPH, 'Finland', 'Finland'),
  z('nl', CPH, 'Netherlands', 'Holland'),
  z('de', 'Europe/Berlin', 'Germany and Luxembourg (DE-LU)', 'Tyskland og Luxembourg (DE-LU)', { source: SOURCE_ENERGY_CHARTS }),
  z('fr', 'Europe/Paris', 'France', 'Frankrig', { source: SOURCE_ENERGY_CHARTS }),
  z('pl', 'Europe/Warsaw', 'Poland', 'Polen', { source: SOURCE_ENERGY_CHARTS }),
  z('it-n', 'Europe/Rome', 'Italy - North (IT-North)', 'Italien - Nord (IT-Nord)', { source: SOURCE_ENERGY_CHARTS }),
  z('at', 'Europe/Vienna', 'Austria', 'Østrig', { source: SOURCE_ENERGY_CHARTS }),
  z('be', 'Europe/Brussels', 'Belgium', 'Belgien', { source: SOURCE_ENERGY_CHARTS }),
  z('ch', 'Europe/Zurich', 'Switzerland', 'Schweiz', { source: SOURCE_ENERGY_CHARTS }),
  z('cz', 'Europe/Prague', 'Czechia', 'Tjekkiet', { source: SOURCE_ENERGY_CHARTS }),
  z('hu', 'Europe/Budapest', 'Hungary', 'Ungarn', { source: SOURCE_ENERGY_CHARTS }),
  z('si', 'Europe/Ljubljana', 'Slovenia', 'Slovenien', { source: SOURCE_ENERGY_CHARTS }),
  z('es', 'Europe/Madrid', 'Spain', 'Spanien'),
  z('pt', 'Europe/Lisbon', 'Portugal', 'Portugal'),
  z('sk', 'Europe/Bratislava', 'Slovakia', 'Slovakiet'),
  z('gr', 'Europe/Athens', 'Greece', 'Grækenland'),
  z('ro', 'Europe/Bucharest', 'Romania', 'Rumænien'),
  z('bg', 'Europe/Sofia', 'Bulgaria', 'Bulgarien'),
  z('hr', 'Europe/Zagreb', 'Croatia', 'Kroatien'),
  z('rs', 'Europe/Belgrade', 'Serbia', 'Serbien'),
  z('ee', 'Europe/Tallinn', 'Estonia', 'Estland'),
  z('lv', 'Europe/Riga', 'Latvia', 'Letland'),
  z('lt', 'Europe/Vilnius', 'Lithuania', 'Litauen'),
  z('me', 'Europe/Podgorica', 'Montenegro', 'Montenegro'),
  z('mk', 'Europe/Skopje', 'North Macedonia', 'Nordmakedonien'),
  z('al', 'Europe/Tirane', 'Albania', 'Albanien'),
  z('xk', 'Europe/Belgrade', 'Kosovo', 'Kosovo'),
  z('gb', 'Europe/London', 'Great Britain (within-day market index, not day-ahead)', 'Storbritannien (within-day-indeks, ikke day-ahead)', {
    source: SOURCE_ELEXON,
    latestKnown: true,
  }),
  z('ie', 'Europe/Dublin', 'Ireland (all-island market)', 'Irland (hele ø-markedet)'),
];

const BY_KEY = new Map(ZONES.map((zone) => [zone.key, zone]));

const SOURCE_NOTES = {
  [SOURCE_ENERGY_CHARTS]:
    'Price data: Bundesnetzagentur | SMARD.de via Energy-Charts.info, CC BY 4.0; hourly means of the 15-minute prices (changed)',
  [SOURCE_ELEXON]: 'Contains BMRS data © Elexon Limited copyright and database right {year}',
};

function getZone(key) {
  return BY_KEY.get(String(key || '').toLowerCase()) || null;
}

function zoneLabel(zone, language) {
  return zone.label[language === 'da' ? 'da' : 'en'];
}

function isDanish(zone) {
  return zone.area !== null;
}

/** Licence/attribution line for a zone (empty string if the source needs none). */
function attribution(zone, year = new Date().getUTCFullYear()) {
  const note = zone.source ? SOURCE_NOTES[zone.source] : '';
  return note.replace('{year}', String(year));
}

// --- Denmark ----------------------------------------------------------------
// Price modes of /api/forecast (see /api/openapi.json). DKK/kWh.
const DK_MODES = [
  'inkl_alt',
  'spot_inkl',
  'spot_ex',
  'inkl_alt_minus',
  'inkl_alt_elvarme',
  'net_inkl_alt',
  'net_inkl_alt_elvarme',
  'net_inkl_tarif',
];
// These need a grid company (GLN).
const NET_MODES = new Set(['net_inkl_alt', 'net_inkl_alt_elvarme', 'net_inkl_tarif']);

// Danish grid companies: [name, GLN, area]. Copied from the Home Assistant
// integration (which copies the NETS table of the elpriser.org front page) -
// KEEP IN SYNC. The settings also accept a free-typed GLN for anything not listed.
const DK_GRID_COMPANIES = [
  ['N1', '5790001089030', 'DK1'],
  ['Trefor', '5790000392261', 'DK1'],
  ['Konstant', '5790000704842', 'DK1'],
  ['Dinel', '5790000610099', 'DK1'],
  ['Vores Elnet', '5790000610976', 'DK1'],
  ['Ravdex', '5790000836727', 'DK1'],
  ['RAH Net', '5790000681327', 'DK1'],
  ['Elværk', '5790000681358', 'DK1'],
  ['Nord Energi', '5790000610877', 'DK1'],
  ['NOE Net', '5790000395620', 'DK1'],
  ['Elnet Midt', '5790001100520', 'DK1'],
  ['Flow Elnet', '5790000392551', 'DK1'],
  ['LNet', '5790001090111', 'DK1'],
  ['Veksel', '5790001088217', 'DK1'],
  ['Ikast El Net', '5790000682102', 'DK1'],
  ['Midtfyns Elforsyning', '5790001089023', 'DK1'],
  ['Elinord', '5790001095277', 'DK1'],
  ['Læsø Elnet', '5790001103460', 'DK1'],
  ['Sunds Net', '5790001095444', 'DK1'],
  ['Tarm Elværk', '5790000706419', 'DK1'],
  ['Hammel Elforsyning', '5790001090166', 'DK1'],
  ['Grindsted Elnet', '5790000681105', 'DK1'],
  ['Forsyning Elnet', '5790001088309', 'DK1'],
  ['Aal El-Net', '5790001095451', 'DK1'],
  ['Hjerting', '5790001095376', 'DK1'],
  ['Hurup Elværk', '5790000610839', 'DK1'],
  ['Cerius', '5790000705184', 'DK2'],
  ['Trefor Øst', '5790000706686', 'DK2'],
  ['Radius', '5790000705689', 'DK2'],
  ['Elektrus', '5790000836239', 'DK2'],
  ['Zeanet', '5790001089375', 'DK2'],
];

/** The GLN to use: a free-typed one wins over the dropdown. Returns '' if none. */
function resolveGln(settings) {
  const custom = String((settings && settings.gln_custom) || '').trim();
  if (custom) return custom;
  const picked = String((settings && settings.grid_company) || '').trim();
  return picked && picked !== 'none' ? picked : '';
}

function isValidGln(value) {
  return /^\d{13}$/.test(String(value));
}

module.exports = {
  ZONES,
  DK_MODES,
  NET_MODES,
  DK_GRID_COMPANIES,
  getZone,
  zoneLabel,
  isDanish,
  attribution,
  resolveGln,
  isValidGln,
};
