'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../drivers/zone/device.js');
const Driver = require('../drivers/zone/driver.js');
const api = require('../lib/api');
const prices = require('../lib/prices');
const zones = require('../lib/zones');
const driverManifest = require('../drivers/zone/driver.compose.json');
const { fixture, fakeFetch } = require('./helpers');

const NOW = Date.parse('2026-11-03T07:42:00Z'); // 08:42 CET

function en(key, tokens) {
  return tokens ? `${key} ${JSON.stringify(tokens)}` : key;
}

function setup({ id = 'de', settings = {}, store = {}, now = NOW, responder } = {}) {
  const timers = [];
  const fired = [];
  const homey = {
    manifest: { version: '0.0.0-test' },
    __: en,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.cleared = true;
    },
    flow: {
      getDeviceTriggerCard: (cardId) => ({
        trigger: async (device, tokens, state) => {
          fired.push({ id: cardId, tokens, state });
        },
      }),
    },
  };
  const device = new Device({
    data: { id },
    settings: { cheap_hours: 4, price_mode: 'inkl_alt', grid_company: 'none', gln_custom: '', ...settings },
    store,
    capabilities: driverManifest.capabilities,
    homey,
  });
  const clock = { now };
  device._now = () => clock.now;
  const fetchImpl = fakeFetch(responder || (() => ({ status: 200, headers: { ETag: '"v1"' }, body: fixture('nordic_de.json') })));
  device._fetchImpl = fetchImpl;
  const live = () => timers.filter((t) => !t.cleared);
  return { device, clock, timers, live, fired, fetchImpl };
}

const cap = (device, id) => device.getCapabilityValue(id);

test('first start without cache: unavailable, a fetch is scheduled at once, then everything is filled in', async () => {
  const { device, live, fetchImpl } = setup();
  await device.onInit();
  assert.equal(device.available, false);
  assert.equal(device.unavailableMessage, 'device.no_data');
  const fetchTimer = live().find((t) => t.ms === 0);
  assert.ok(fetchTimer, 'a fetch timer with no delay');

  await device._refresh();
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://elpriser.org/api/nordic?zone=de');
  assert.equal(device.available, true);
  assert.equal(cap(device, 'measure_price'), 0.30131);
  assert.equal(cap(device, 'measure_price_next'), 0.27094);
  assert.equal(cap(device, 'measure_price_min'), 0.22207);
  assert.equal(cap(device, 'measure_price_max'), 0.31358);
  assert.equal(cap(device, 'measure_price_avg'), 0.25285);
  assert.equal(cap(device, 'price_level'), 'expensive');
  assert.equal(cap(device, 'cheap_hour_now'), false);
  assert.match(cap(device, 'cheapest_hour_start'), /^\d\d:00$/);
  assert.equal(device._capOptions.measure_price.units, 'EUR/kWh');
  assert.equal(device.getStoreValue('cache').key, 'https://elpriser.org/api/nordic?zone=de');
});

test('after the first answer the next fetch is the 13:05 CET window, not a poll', async () => {
  const { device, clock, live } = setup();
  await device.onInit();
  await device._refresh();
  const fetchTimers = live().filter((t) => t.ms > 60 * 1000 && t.ms !== 3600000);
  const delays = live().map((t) => t.ms);
  // hour tick (<= 1 h) and one fetch timer: the 13:0x CET publication window
  const at = clock.now + Math.max(...delays);
  const cet = new Date(at + 3600 * 1000).toISOString();
  assert.match(cet, /^2026-11-03T13:0[5-9]/, cet);
  assert.ok(fetchTimers.length >= 1);
});

test('cache from the store is shown at once, without any request', async () => {
  const first = setup();
  await first.device.onInit();
  await first.device._refresh();
  const store = { cache: first.device.getStoreValue('cache') };

  const { device, fetchImpl } = setup({ store });
  await device.onInit();
  assert.equal(device.available, true);
  assert.equal(cap(device, 'measure_price'), 0.30131);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a cache made for other settings is ignored', async () => {
  const first = setup({ id: 'dk1', responder: () => ({ status: 200, body: fixture('forecast_dk1.json') }) });
  await first.device.onInit();
  await first.device._refresh();
  assert.equal(cap(first.device, 'measure_price'), 2.9896);
  assert.equal(first.fetchImpl.calls[0].url, 'https://elpriser.org/api/forecast?area=DK1&mode=inkl_alt');
  const store = { cache: first.device.getStoreValue('cache') };

  const other = setup({ id: 'dk1', store, settings: { price_mode: 'spot_ex' } });
  await other.device.onInit();
  assert.equal(other.device.available, false);
});

test('the hour tick moves to the next hour and fires the flow triggers', async () => {
  const { device, clock, fired } = setup();
  await device.onInit();
  await device._refresh();
  const de = fixture('nordic_de.json').days.find((d) => d.date === '2026-11-03').prices;
  const hourOf = (h) => de[h].eur_mwh / 1000;

  fired.length = 0;
  clock.now = Date.parse('2026-11-03T08:00:02Z'); // 09:00:02 CET
  await device._onHour();
  assert.equal(cap(device, 'measure_price'), hourOf(9));
  const ids = fired.map((f) => f.id);
  assert.ok(ids.includes('price_below') && ids.includes('price_above'));
  const below = fired.find((f) => f.id === 'price_below');
  assert.equal(below.tokens.price, hourOf(9));
  assert.equal(below.state.previousPrice, hourOf(8));
});

test('walking all 24 hours of a real day: exactly one cheapest-hour trigger, at the cheapest hour', async () => {
  const { device, clock, fired } = setup({ now: Date.parse('2026-11-02T23:30:00Z') }); // 00:30 CET
  await device.onInit();
  await device._refresh();
  const raw = fixture('nordic_de.json').days.find((d) => d.date === '2026-11-03').prices.map((r) => r.eur_mwh);
  const cheapestHour = raw.indexOf(Math.min(...raw));
  fired.length = 0;
  for (let h = 1; h < 24; h += 1) {
    clock.now = prices.localMidnight('2026-11-03', 'Europe/Berlin') + h * prices.HOUR_MS + 2000;
    await device._onHour();
  }
  const cheapest = fired.filter((f) => f.id === 'cheapest_hour_starts');
  if (cheapestHour === 0) {
    assert.equal(cheapest.length, 0);
  } else {
    assert.equal(cheapest.length, 1);
    assert.equal(cheapest[0].tokens.hour, cheapestHour);
  }
  // price_level_changed always reports a level and the one before it
  for (const f of fired.filter((x) => x.id === 'price_level_changed')) {
    assert.ok(['cheap', 'normal', 'expensive'].includes(f.tokens.level));
    assert.equal(f.state.level, f.tokens.level);
  }
});

test('offline: failed fetches keep the cached prices, warn after two failures, and back off', async () => {
  const first = setup();
  await first.device.onInit();
  await first.device._refresh();
  const store = { cache: first.device.getStoreValue('cache') };

  const { device, clock, fetchImpl } = setup({ store, responder: () => new Error('ENOTFOUND') });
  await device.onInit();
  clock.now += 4 * 3600 * 1000; // 12:42 CET, nothing fetched yet
  await device._refresh();
  assert.equal(device.available, true);
  assert.equal(cap(device, 'measure_price') !== null, true);
  assert.equal(device.warning, null, 'one failure is not worth a warning');
  await device._refresh();
  assert.equal(device.warning, 'warning.offline');
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(device.available, true);
  assert.ok(device.errors.some((e) => /network/.test(e)));

  // a success clears the warning again
  device._fetchImpl = fakeFetch(() => ({ status: 200, body: fixture('nordic_de.json') }));
  await device._refresh();
  assert.equal(device.warning, null);
});

test('offline past the end of the held data: unavailable with the offline message, no stale price', async () => {
  const first = setup();
  await first.device.onInit();
  await first.device._refresh();
  const store = { cache: first.device.getStoreValue('cache') };

  const { device, clock } = setup({ store, responder: () => new Error('offline') });
  await device.onInit();
  clock.now = Date.parse('2026-11-12T10:00:00Z'); // ten days later: the cache no longer covers this hour
  await device._refresh();
  assert.equal(device.available, false);
  assert.equal(device.unavailableMessage, 'device.no_data_offline');
  assert.equal(cap(device, 'measure_price'), null);
  assert.equal(cap(device, 'cheap_hour_now'), null);
});

test('a forecast hour is never shown as the price', async () => {
  const { device, clock } = setup();
  await device.onInit();
  await device._refresh();
  clock.now = Date.parse('2026-11-04T10:00:00Z'); // tomorrow, which is only a forecast in this recording
  await device._compute({ fire: false });
  assert.equal(device.available, false);
  assert.equal(cap(device, 'measure_price'), null);
});

test('a 429 with Retry-After is remembered', async () => {
  const { device, clock } = setup({ responder: () => ({ status: 429, headers: { 'Retry-After': '1800' } }) });
  await device.onInit();
  await device._refresh();
  assert.equal(device._retryAfter, clock.now + 1800 * 1000);
  const wait = device._timers.fetch.ms;
  assert.ok(wait >= 1800 * 1000, `${wait}`);
});

test('304 Not Modified keeps the data and sends the ETag', async () => {
  let n = 0;
  const { device, clock, fetchImpl } = setup({
    responder: () => (++n === 1 ? { status: 200, headers: { ETag: '"v1"' }, body: fixture('nordic_de.json') } : { status: 304 }),
  });
  await device.onInit();
  await device._refresh();
  clock.now += 6 * 3600 * 1000;
  await device._refresh();
  assert.equal(fetchImpl.calls[1].headers['If-None-Match'], '"v1"');
  assert.equal(device._failures, 0);
  assert.equal(device.available, true);
});

test('settings are validated', async () => {
  const { device } = setup({ id: 'dk1' });
  await device.onInit();
  const base = { cheap_hours: 4, price_mode: 'inkl_alt', grid_company: 'none', gln_custom: '' };
  await assert.doesNotReject(device.onSettings({ newSettings: base, changedKeys: [] }));
  await assert.rejects(device.onSettings({ newSettings: { ...base, price_mode: 'bogus' }, changedKeys: [] }), /settings.bad_mode/);
  await assert.rejects(device.onSettings({ newSettings: { ...base, price_mode: 'net_inkl_alt' }, changedKeys: [] }), /need_grid_company/);
  await assert.rejects(device.onSettings({ newSettings: { ...base, gln_custom: '12345' }, changedKeys: [] }), /bad_gln/);
  await assert.rejects(device.onSettings({ newSettings: { ...base, cheap_hours: 0 }, changedKeys: [] }), /bad_cheap_hours/);
  await assert.rejects(device.onSettings({ newSettings: { ...base, cheap_hours: 13 }, changedKeys: [] }), /bad_cheap_hours/);
  await assert.doesNotReject(device.onSettings({ newSettings: { ...base, price_mode: 'net_inkl_alt', grid_company: '5790000705689' }, changedKeys: [] }));
});

test('Danish settings reach the request: mode and GLN', async () => {
  const { device, fetchImpl } = setup({
    id: 'dk2',
    settings: { price_mode: 'net_inkl_alt', grid_company: '5790000705689' },
    responder: () => ({ status: 200, body: { ...fixture('forecast_dk1.json'), area: 'DK2' } }),
  });
  await device.onInit();
  await device._refresh();
  assert.equal(fetchImpl.calls[0].url, 'https://elpriser.org/api/forecast?area=DK2&mode=net_inkl_alt&gln=5790000705689');
  assert.equal(device._capOptions.measure_price.units, 'DKK/kWh');
});

test('the cheap-hours setting changes cheap_hour_now', async () => {
  const { device, clock } = setup({ settings: { cheap_hours: 1 } });
  await device.onInit();
  await device._refresh();
  const raw = fixture('nordic_de.json').days.find((d) => d.date === '2026-11-03').prices.map((r) => r.eur_mwh);
  const second = raw.map((v, h) => [v, h]).sort((a, b) => a[0] - b[0])[1][1];
  clock.now = prices.localMidnight('2026-11-03', 'Europe/Berlin') + second * prices.HOUR_MS + 60000;
  await device._compute({ fire: false });
  assert.equal(cap(device, 'cheap_hour_now'), false);
  device._settings.cheap_hours = 2;
  await device._compute({ fire: false });
  assert.equal(cap(device, 'cheap_hour_now'), true);
});

test('GB: shows the last complete hour; next hour and cheap hour stay empty', async () => {
  const { device } = setup({ id: 'gb', responder: () => ({ status: 200, body: fixture('nordic_gb.json') }) });
  await device.onInit();
  await device._refresh();
  assert.equal(cap(device, 'measure_price'), 0.20206);
  assert.equal(cap(device, 'measure_price_next'), null);
  assert.equal(cap(device, 'cheap_hour_now'), null);
  assert.equal(cap(device, 'cheapest_hour_start'), null);
  assert.equal(device.isAmongCheapest(3), false);
  assert.equal(device._capOptions.measure_price.units, 'GBP/kWh');
});

test('an unknown zone id makes the device unavailable instead of crashing', async () => {
  const { device } = setup({ id: 'xx' });
  await device.onInit();
  assert.equal(device.available, false);
  assert.match(device.unavailableMessage, /unknown_zone/);
});

test('timers are cleared when the device goes away', async () => {
  const { device, live } = setup();
  await device.onInit();
  assert.ok(live().length >= 2);
  await device.onDeleted();
  assert.equal(live().length, 0);
});

// -- the driver: zone picker and flow card listeners ------------------------------

function driverSetup() {
  const cards = {}; // triggers by id; conditions as `condition:<id>`
  const make = (key) => (cards[key] ||= { key, listener: null, registerRunListener(fn) { this.listener = fn; } });
  const driver = new Driver();
  driver.homey = {
    flow: { getDeviceTriggerCard: (id) => make(id), getConditionCard: (id) => make(`condition:${id}`) },
    i18n: { getLanguage: () => 'en' },
  };
  return { driver, cards };
}

test('the zone picker lists all 40 zones with unique ids', async () => {
  const { driver } = driverSetup();
  const list = await driver.onPairListDevices();
  assert.equal(list.length, 40);
  assert.equal(new Set(list.map((d) => d.data.id)).size, 40);
  assert.equal(list[0].name, 'Denmark - DK1 West (Jutland, Funen)');
  assert.match(list.find((d) => d.data.id === 'gb').settings.data_source, /Elexon/);
  driver.homey.i18n.getLanguage = () => 'da';
  assert.equal((await driver.onPairListDevices())[0].name, 'Danmark - DK1 Vest (Jylland, Fyn)');
});

test('price_below fires when the price crosses the value, not on every hour below it', async () => {
  const { driver, cards } = driverSetup();
  await driver.onInit();
  const below = cards.price_below.listener;
  assert.equal(await below({ threshold: 1 }, { price: 0.9, previousPrice: 1.2 }), true);
  assert.equal(await below({ threshold: 1 }, { price: 0.8, previousPrice: 0.9 }), false);
  assert.equal(await below({ threshold: 1 }, { price: 1.1, previousPrice: 1.2 }), false);
  assert.equal(await below({ threshold: 1 }, { price: 0.9, previousPrice: null }), true);
  const above = cards.price_above.listener;
  assert.equal(await above({ threshold: 1 }, { price: 1.5, previousPrice: 0.9 }), true);
  assert.equal(await above({ threshold: 1 }, { price: 1.5, previousPrice: 1.4 }), false);
});

test('price_level_changed can be filtered by level; conditions read the device', async () => {
  const { driver, cards } = driverSetup();
  await driver.onInit();
  const changed = cards.price_level_changed.listener;
  assert.equal(await changed({ level: 'any' }, { level: 'cheap' }), true);
  assert.equal(await changed({ level: 'cheap' }, { level: 'cheap' }), true);
  assert.equal(await changed({ level: 'cheap' }, { level: 'expensive' }), false);

  const device = { isAmongCheapest: (n) => n <= 3, getPrice: () => 0.5, getLevel: () => 'normal' };
  assert.equal(await cards['condition:in_cheapest_hours'].listener({ device, hours: 3 }), true);
  assert.equal(await cards['condition:in_cheapest_hours'].listener({ device, hours: 4.2 }), false);
  const conditionBelow = cards['condition:price_below'].listener;
  assert.equal(await conditionBelow({ device, threshold: 0.6 }), true);
  assert.equal(await conditionBelow({ device, threshold: 0.5 }), false);
  assert.equal(await conditionBelow({ device: { getPrice: () => null }, threshold: 9 }), false);
  assert.equal(await cards['condition:price_level_is'].listener({ device, level: 'normal' }), true);
  assert.equal(await cards['condition:price_level_is'].listener({ device, level: 'cheap' }), false);
});

test('the API client module is the one the device uses', () => {
  assert.equal(typeof api.fetchDayset, 'function');
  assert.equal(zones.ZONES.length, 40);
});
