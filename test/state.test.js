'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const prices = require('../lib/prices');
const state = require('../lib/state');
const zones = require('../lib/zones');
const { fixture } = require('./helpers');

const NOW = Date.parse('2026-11-03T07:42:00Z'); // 08:42 in Copenhagen/Berlin

function de() {
  return prices.parseNordic(fixture('nordic_de.json'), 'de');
}

test('DE: the numbers equal what the raw payload says (EUR/MWh / 1000)', () => {
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  const raw = fixture('nordic_de.json').days.find((d) => d.date === '2026-11-03').prices.map((r) => r5(r.eur_mwh / 1000));
  const st = state.computeState(de(), zones.getZone('de'), NOW);
  assert.equal(st.covered, true);
  assert.equal(st.price, raw[8]);
  assert.equal(st.nextPrice, raw[9]);
  assert.equal(st.min, Math.min(...raw));
  assert.equal(st.max, Math.max(...raw));
  assert.equal(st.avg, r5(raw.reduce((a, b) => a + b, 0) / raw.length));
  assert.equal(st.currency, 'EUR');
  assert.equal(st.unit, 'EUR/kWh');
  assert.equal(st.cheapestStart, prices.localMidnight('2026-11-03', 'Europe/Berlin') + raw.indexOf(Math.min(...raw)) * prices.HOUR_MS);
});

test('DE: tomorrow is only a forecast, so it is not published and the 23:00 next hour is unknown', () => {
  const zone = zones.getZone('de');
  const st = state.computeState(de(), zone, NOW);
  assert.equal(st.tomorrowPublished, false);
  const late = Date.parse('2026-11-03T22:30:00Z'); // 23:30 Berlin
  const stLate = state.computeState(de(), zone, late);
  assert.equal(stLate.covered, true);
  assert.equal(stLate.nextPrice, null);
});

test('once tomorrow is published it is the next hour at 23:00 and tomorrowPublished is true', () => {
  const dayset = de();
  dayset.days.find((d) => d.date === '2026-11-04').kind = 'actual';
  const st = state.computeState(dayset, zones.getZone('de'), Date.parse('2026-11-03T22:30:00Z'));
  assert.equal(st.tomorrowPublished, true);
  assert.equal(st.nextPrice, dayset.days.find((d) => d.date === '2026-11-04').values[0]);
});

test('DK1 matches /api/now of the same moment (hour 8 = 2.9896 DKK/kWh) and the HA README stats', () => {
  const dk = prices.parseForecast(fixture('forecast_dk1.json'), 'dk1', 'DK1');
  const st = state.computeState(dk, zones.getZone('dk1'), NOW);
  assert.equal(st.price, 2.9896);
  assert.equal(st.min, 2.209);
  assert.equal(st.max, 3.0903);
  assert.equal(st.level, 'expensive');
  assert.equal(st.unit, 'DKK/kWh');
});

test('cheapHourNow follows the number of cheap hours', () => {
  const zone = zones.getZone('de');
  const dayset = de();
  const today = dayset.days.find((d) => d.date === '2026-11-03').values;
  const cheapestHour = today.indexOf(Math.min(...today));
  const at = (hour) => prices.localMidnight('2026-11-03', 'Europe/Berlin') + hour * prices.HOUR_MS + 60000;
  assert.equal(state.computeState(dayset, zone, at(cheapestHour), { cheapHours: 1 }).cheapHourNow, true);
  assert.equal(state.computeState(dayset, zone, at(cheapestHour), { cheapHours: 1 }).isCheapestHourNow, true);
  const dearestHour = today.indexOf(Math.max(...today));
  assert.equal(state.computeState(dayset, zone, at(dearestHour), { cheapHours: 12 }).cheapHourNow, false);
  assert.equal(state.isAmongCheapest(dayset, zone, at(cheapestHour), 1), true);
  assert.equal(state.isAmongCheapest(dayset, zone, at(dearestHour), 3), false);
  assert.equal(state.isAmongCheapest(dayset, zone, at(cheapestHour) + 40 * 24 * prices.HOUR_MS, 3), null);
});

test('no data for the current hour: not covered, nothing invented', () => {
  const st = state.computeState(de(), zones.getZone('de'), Date.parse('2026-12-24T12:00:00Z'));
  assert.equal(st.covered, false);
  assert.equal(st.price, null);
  assert.equal(st.cheapHourNow, null);
  assert.equal(st.level, null);
});

test('GB: price is the last complete hour, next hour and cheap-hour are unknown', () => {
  const gb = prices.parseNordic(fixture('nordic_gb.json'), 'gb');
  const zone = zones.getZone('gb');
  const st = state.computeState(gb, zone, NOW); // 07:42 UTC: hour 7 is not priced yet, hour 6 is
  assert.equal(st.covered, true);
  assert.equal(st.isLatestKnown, true);
  assert.equal(st.price, 0.20206);
  assert.equal(st.slotStart, Date.parse('2026-11-03T06:00:00Z'));
  assert.equal(st.nextPrice, null);
  assert.equal(st.cheapHourNow, null);
  assert.equal(st.cheapestStart, null);
  assert.equal(state.isAmongCheapest(gb, zone, NOW, 3), null);
  // ...but not for ever
  const old = state.computeState(gb, zone, Date.parse('2026-11-03T12:00:00Z'));
  assert.equal(old.covered, false);
});

test('diffEvents fires only when the hour moved on', () => {
  const base = { covered: true, slotStart: 1, price: 2, level: 'normal', cheapHourNow: false, isCheapestHourNow: false };
  assert.equal(state.diffEvents(base, { ...base }).hourChanged, false);
  assert.equal(state.diffEvents(base, { ...base, price: 1, level: 'cheap' }).hourChanged, false);
  assert.equal(state.diffEvents(null, base).hourChanged, false);
  assert.equal(state.diffEvents(base, { ...base, covered: false, slotStart: null }).hourChanged, false);

  const next = { ...base, slotStart: 2, price: 1, level: 'cheap', cheapHourNow: true, isCheapestHourNow: true };
  const ev = state.diffEvents(base, next);
  assert.equal(ev.hourChanged, true);
  assert.deepEqual(ev.belowAbove, { price: 1, previousPrice: 2 });
  assert.equal(ev.cheapestHourStarts, true);
  assert.equal(ev.cheapHourStarted, true);
  assert.deepEqual(ev.levelChanged, { level: 'cheap', previousLevel: 'normal' });

  // a second cheap hour in a row is not a new "cheap hour started"; same level is not a change
  const again = state.diffEvents(next, { ...next, slotStart: 3, isCheapestHourNow: false });
  assert.equal(again.cheapHourStarted, false);
  assert.equal(again.levelChanged, null);
  assert.equal(again.cheapestHourStarts, false);
});

test('walking a real day hour by hour fires cheapestHourStarts exactly once', () => {
  const dayset = de();
  const zone = zones.getZone('de');
  const start = prices.localMidnight('2026-11-03', 'Europe/Berlin');
  let prev = null;
  let fired = 0;
  for (let h = 0; h < 24; h += 1) {
    const next = state.computeState(dayset, zone, start + h * prices.HOUR_MS + 5000);
    if (state.diffEvents(prev, next).cheapestHourStarts) fired += 1;
    prev = next;
  }
  assert.equal(fired, 1);
});
