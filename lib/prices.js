'use strict';

/**
 * Pure parsing and price arithmetic - no Homey imports, so it can be unit tested
 * against recorded API responses.
 *
 * The API speaks in *local hours*: { date: "2026-11-03", prices: [{ hour: 0, ... }] }
 * where `hour` is the wall-clock hour of the zone (see zones.js for which wall
 * clock). We keep that shape in a compact "day set" (24 values per day, indexed by
 * local hour) and expand it to absolute one-hour slots when asked a question,
 * which is the only representation that survives daylight saving time:
 *  - a 25-hour day (clocks go back): the API carries ONE value for the doubled
 *    local hour 2 (the mean of both). We emit 25 slots; both 02:00-03:00 slots
 *    carry that value.
 *  - a 23-hour day (clocks go forward): the API has no hour 2; we emit 23 slots.
 */

const HOUR_MS = 3600 * 1000;
const DECIMALS = 5;

const KIND_ACTUAL = 'actual';
const KIND_FORECAST = 'forecast';

const LEVEL_CHEAP = 'cheap';
const LEVEL_NORMAL = 'normal';
const LEVEL_EXPENSIVE = 'expensive';

class PriceDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PriceDataError';
  }
}

// ---------------------------------------------------------------------------
// Time zone helpers (Intl only, no dependencies)
// ---------------------------------------------------------------------------

const formatters = new Map();

function formatterFor(tz) {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, fmt);
  }
  return fmt;
}

/** Wall-clock parts of an instant in a zone. */
function localParts(ms, tz) {
  const out = {};
  for (const part of formatterFor(tz).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** "YYYY-MM-DD" of an instant on the wall clock of `tz`. */
function localDate(ms, tz) {
  const p = localParts(ms, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

function localHour(ms, tz) {
  return localParts(ms, tz).hour;
}

/** Offset (ms) of `tz` from UTC at the instant `ms`: local wall clock minus UTC. */
function offsetAt(ms, tz) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of local midnight at the start of `dateStr` (YYYY-MM-DD). */
function localMidnight(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  let result = guess - offsetAt(guess, tz);
  // The offset can differ between the guess and the real instant; one more round settles it.
  result = guess - offsetAt(result, tz);
  return result;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** UTC start (ms) of every hour of the local calendar day `dateStr` (23, 24 or 25 of them). */
function localDayStarts(dateStr, tz) {
  const start = localMidnight(dateStr, tz);
  const end = localMidnight(addDays(dateStr, 1), tz);
  const count = Math.round((end - start) / HOUR_MS);
  return Array.from({ length: count }, (_, i) => start + i * HOUR_MS);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value) {
  if (value === null) return null;
  const f = 10 ** DECIMALS;
  return Math.round(value * f) / f;
}

function parseDays(payload, priceKey, scale) {
  if (!payload || !Array.isArray(payload.days) || payload.days.length === 0) {
    throw new PriceDataError('response has no days');
  }
  const byDate = new Map();
  for (const day of payload.days) {
    if (!day || typeof day !== 'object') continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day.date))) continue;
    if (!Array.isArray(day.prices)) continue;
    const values = new Array(24).fill(null);
    for (const row of day.prices) {
      if (!row || !Number.isInteger(row.hour) || row.hour < 0 || row.hour > 23) continue;
      const v = num(row[priceKey]);
      values[row.hour] = v === null ? null : round(v * scale);
    }
    byDate.set(day.date, {
      date: day.date,
      kind: day.type === KIND_FORECAST ? KIND_FORECAST : KIND_ACTUAL,
      values,
    });
  }
  if (byDate.size === 0) throw new PriceDataError('response has no usable days');
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Parse ``/api/nordic?zone=<zone>`` (hourly ``eur_mwh``, ``zoneInfo`` with the rate).
 * Despite the field name the unit is whatever ``unit`` says (GBP/MWh for gb).
 * Local currency per kWh = value * zoneInfo.rate / 1000 (rate is 1 for gb).
 */
function parseNordic(payload, zoneKey) {
  if (!payload || typeof payload !== 'object') throw new PriceDataError('response is not an object');
  if (typeof payload.zone === 'string' && payload.zone.toLowerCase() !== zoneKey) {
    throw new PriceDataError(`response is for zone ${payload.zone}, not ${zoneKey}`);
  }
  const info = payload.zoneInfo;
  if (!info || typeof info !== 'object') throw new PriceDataError('response has no zoneInfo');
  if (typeof info.currency !== 'string' || info.currency.length !== 3) throw new PriceDataError('zoneInfo has no currency');
  const rate = num(info.rate);
  if (rate === null || rate <= 0) throw new PriceDataError('zoneInfo has no usable rate');
  const days = parseDays(payload, 'eur_mwh', rate / 1000);
  return {
    zone: zoneKey,
    currency: info.currency.toUpperCase(),
    unit: `${info.currency.toUpperCase()}/kWh`,
    rate,
    rateDate: typeof info.rateDate === 'string' ? info.rateDate : null,
    generated: typeof payload.generated === 'string' ? payload.generated : null,
    days,
  };
}

/** Parse the Danish ``/api/forecast`` (``price`` in DKK/kWh). */
function parseForecast(payload, zoneKey, area) {
  if (!payload || typeof payload !== 'object') throw new PriceDataError('response is not an object');
  if (typeof payload.area === 'string' && payload.area.toUpperCase() !== area) {
    throw new PriceDataError(`response is for ${payload.area}, not ${area}`);
  }
  const days = parseDays(payload, 'price', 1);
  return {
    zone: zoneKey,
    currency: 'DKK',
    unit: 'DKK/kWh',
    rate: null,
    rateDate: null,
    generated: typeof payload.generated === 'string' ? payload.generated : null,
    days,
  };
}

// ---------------------------------------------------------------------------
// Slots and queries
// ---------------------------------------------------------------------------

/**
 * Expand a parsed day set into absolute one-hour slots, in time order:
 * { start, end, value, kind } with start/end as epoch ms.
 */
function expandSlots(dayset, tz) {
  const slots = [];
  for (const day of dayset.days) {
    for (const start of localDayStarts(day.date, tz)) {
      const value = day.values[localHour(start, tz)];
      if (value === undefined) continue;
      slots.push({ start, end: start + HOUR_MS, value, kind: day.kind });
    }
  }
  return slots;
}

function slotContaining(slots, now) {
  return slots.find((s) => s.start <= now && now < s.end) || null;
}

/** Slots of the zone's local calendar day `dateStr`. */
function slotsOn(slots, dateStr, tz) {
  return slots.filter((s) => localDate(s.start, tz) === dateStr);
}

/** Settled prices only: a model forecast is never shown as "the price". */
function settled(slots) {
  return slots.filter((s) => s.kind === KIND_ACTUAL && s.value !== null);
}

function dayStats(slots) {
  const priced = settled(slots);
  if (priced.length === 0) return null;
  let minimum = priced[0];
  let maximum = priced[0];
  let sum = 0;
  for (const s of priced) {
    if (s.value < minimum.value) minimum = s;
    if (s.value > maximum.value) maximum = s;
    sum += s.value;
  }
  return { minimum, maximum, average: round(sum / priced.length), count: priced.length };
}

/** The `count` cheapest settled slots, earliest wins a tie, returned in time order. */
function cheapestSlots(slots, count) {
  const chosen = [...settled(slots)].sort((a, b) => a.value - b.value || a.start - b.start).slice(0, Math.max(count, 0));
  return chosen.sort((a, b) => a.start - b.start);
}

/**
 * cheap / normal / expensive relative to the day's range: the lowest third is
 * cheap, the highest third expensive. A flat day (range below 0.5 % of the larger
 * absolute price, or zero) is normal.
 */
function priceLevel(value, stats) {
  if (value === null || value === undefined || !stats) return null;
  const low = stats.minimum.value;
  const high = stats.maximum.value;
  const span = high - low;
  if (span <= 0 || span < 0.005 * Math.max(Math.abs(low), Math.abs(high))) return LEVEL_NORMAL;
  const position = (value - low) / span;
  if (position <= 1 / 3) return LEVEL_CHEAP;
  if (position >= 2 / 3) return LEVEL_EXPENSIVE;
  return LEVEL_NORMAL;
}

module.exports = {
  HOUR_MS,
  KIND_ACTUAL,
  KIND_FORECAST,
  LEVEL_CHEAP,
  LEVEL_NORMAL,
  LEVEL_EXPENSIVE,
  PriceDataError,
  localParts,
  localDate,
  localHour,
  localMidnight,
  localDayStarts,
  addDays,
  parseNordic,
  parseForecast,
  expandSlots,
  slotContaining,
  slotsOn,
  settled,
  dayStats,
  cheapestSlots,
  priceLevel,
  round,
};
