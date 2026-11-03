'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const prices = require('../lib/prices');
const { fixture } = require('./helpers');

const CPH = 'Europe/Copenhagen';

test('local day lengths follow daylight saving time', () => {
  assert.equal(prices.localDayStarts('2026-03-28', CPH).length, 24);
  assert.equal(prices.localDayStarts('2026-03-29', CPH).length, 23);
  assert.equal(prices.localDayStarts('2026-10-25', CPH).length, 25);
  assert.equal(prices.localDayStarts('2026-10-25', 'Europe/Lisbon').length, 25);
  assert.equal(prices.localDayStarts('2026-03-29', 'Europe/London').length, 23);
});

test('local midnight is the right UTC instant in winter and summer', () => {
  assert.equal(new Date(prices.localMidnight('2026-11-03', CPH)).toISOString(), '2026-11-02T23:00:00.000Z');
  assert.equal(new Date(prices.localMidnight('2026-07-01', CPH)).toISOString(), '2026-06-30T22:00:00.000Z');
  assert.equal(new Date(prices.localMidnight('2026-11-03', 'Europe/London')).toISOString(), '2026-11-03T00:00:00.000Z');
  assert.equal(new Date(prices.localMidnight('2026-11-03', 'Europe/Athens')).toISOString(), '2026-11-02T22:00:00.000Z');
});

test('localDate and localHour read the zone wall clock', () => {
  const t = Date.parse('2026-11-02T23:30:00Z');
  assert.equal(prices.localDate(t, CPH), '2026-11-03');
  assert.equal(prices.localHour(t, CPH), 0);
  assert.equal(prices.localDate(t, 'Europe/London'), '2026-11-02');
});

test('parseNordic converts EUR/MWh to local currency per kWh', () => {
  const se3 = prices.parseNordic(fixture('nordic_se3.json'), 'se3');
  assert.equal(se3.currency, 'SEK');
  assert.equal(se3.unit, 'SEK/kWh');
  const today = se3.days.find((d) => d.date === '2026-11-03');
  // hour 0: 94.28 EUR/MWh * 10.9475 / 1000
  assert.equal(today.values[0], Math.round(94.28 * 10.9475 * 100) / 100000);
  assert.equal(today.kind, 'actual');
  assert.equal(se3.days.find((d) => d.date === '2026-11-04').kind, 'forecast');
});

test('parseNordic keeps nulls for hours without a price (gb)', () => {
  const gb = prices.parseNordic(fixture('nordic_gb.json'), 'gb');
  const today = gb.days.find((d) => d.date === '2026-11-03');
  assert.equal(gb.currency, 'GBP');
  assert.equal(today.values[0], 0.17705);
  assert.equal(today.values[8], null);
});

test('parseForecast reads the Danish price field as DKK/kWh', () => {
  const dk = prices.parseForecast(fixture('forecast_dk1.json'), 'dk1', 'DK1');
  assert.equal(dk.currency, 'DKK');
  assert.equal(dk.days[0].date, '2026-11-03');
  assert.equal(dk.days[0].values[0], 2.209);
});

test('parsers reject payloads that are not what they claim', () => {
  assert.throws(() => prices.parseNordic(null, 'de'), prices.PriceDataError);
  assert.throws(() => prices.parseNordic({ zone: 'de', days: [] }, 'de'), prices.PriceDataError);
  assert.throws(() => prices.parseNordic(fixture('nordic_de.json'), 'fr'), /not fr/);
  const noRate = fixture('nordic_de.json');
  delete noRate.zoneInfo.rate;
  assert.throws(() => prices.parseNordic(noRate, 'de'), /rate/);
  assert.throws(() => prices.parseForecast(fixture('forecast_dk1.json'), 'dk2', 'DK2'), /not DK2/);
  assert.throws(() => prices.parseForecast({ area: 'DK1', days: [{ date: 'x', prices: [] }] }, 'dk1', 'DK1'), prices.PriceDataError);
});

test('a 25-hour day carries the one API value for both repeated hours', () => {
  const values = Array.from({ length: 24 }, (_, h) => h);
  const dayset = { days: [{ date: '2026-10-25', kind: 'actual', values }] };
  const slots = prices.expandSlots(dayset, CPH);
  assert.equal(slots.length, 25);
  const twos = slots.filter((s) => s.value === 2);
  assert.equal(twos.length, 2);
  assert.equal(twos[1].start - twos[0].start, prices.HOUR_MS);
});

test('a 23-hour day has no hour 2', () => {
  const values = Array.from({ length: 24 }, (_, h) => h);
  const slots = prices.expandSlots({ days: [{ date: '2026-03-29', kind: 'actual', values }] }, CPH);
  assert.equal(slots.length, 23);
  assert.ok(!slots.some((s) => prices.localHour(s.start, CPH) === 2));
});

test('priceLevel: thirds of the range, flat day is normal', () => {
  const stats = { minimum: { value: 1 }, maximum: { value: 4 } };
  assert.equal(prices.priceLevel(1, stats), 'cheap');
  assert.equal(prices.priceLevel(2, stats), 'cheap');
  assert.equal(prices.priceLevel(2.5, stats), 'normal');
  assert.equal(prices.priceLevel(3, stats), 'expensive');
  assert.equal(prices.priceLevel(4, stats), 'expensive');
  assert.equal(prices.priceLevel(2, { minimum: { value: 2 }, maximum: { value: 2 } }), 'normal');
  assert.equal(prices.priceLevel(2.001, { minimum: { value: 2 }, maximum: { value: 2.004 } }), 'normal');
  assert.equal(prices.priceLevel(null, stats), null);
  assert.equal(prices.priceLevel(1, null), null);
});

test('cheapestSlots: earliest wins a tie, result in time order, forecasts never count', () => {
  const mk = (h, value, kind = 'actual') => ({ start: h * prices.HOUR_MS, end: (h + 1) * prices.HOUR_MS, value, kind });
  const slots = [mk(0, 5), mk(1, 1), mk(2, 1), mk(3, 3), mk(4, 0.1, 'forecast'), mk(5, null)];
  assert.deepEqual(prices.cheapestSlots(slots, 2).map((s) => s.start / prices.HOUR_MS), [1, 2]);
  assert.deepEqual(prices.cheapestSlots(slots, 1).map((s) => s.start / prices.HOUR_MS), [1]);
  assert.deepEqual(prices.cheapestSlots(slots, 0), []);
});
