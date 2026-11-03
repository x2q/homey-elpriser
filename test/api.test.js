'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const api = require('../lib/api');
const zones = require('../lib/zones');
const { fixture, fakeFetch } = require('./helpers');

const UA = 'Homey-elpriser/test';
const ok = (name, extra = {}) => ({ status: 200, headers: { ETag: '"abc"' }, body: fixture(name), ...extra });

test('request URLs: Denmark uses /forecast with area, mode and gln; the rest /nordic', () => {
  assert.equal(api.requestUrl(zones.getZone('dk1'), {}), 'https://elpriser.org/api/forecast?area=DK1&mode=inkl_alt');
  assert.equal(
    api.requestUrl(zones.getZone('dk2'), { mode: 'net_inkl_alt', gln: '5790000705689' }),
    'https://elpriser.org/api/forecast?area=DK2&mode=net_inkl_alt&gln=5790000705689',
  );
  assert.equal(api.requestUrl(zones.getZone('it-n'), { mode: 'ignored' }), 'https://elpriser.org/api/nordic?zone=it-n');
});

test('a good answer is parsed and carries the ETag; User-Agent and Accept are sent', async () => {
  const fetchImpl = fakeFetch(() => ok('nordic_de.json'));
  const res = await api.fetchDayset(zones.getZone('de'), {}, { fetchImpl, userAgent: UA });
  assert.equal(res.notModified, false);
  assert.equal(res.etag, '"abc"');
  assert.equal(res.dayset.currency, 'EUR');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].headers['User-Agent'], UA);
  assert.equal(fetchImpl.calls[0].headers.Accept, 'application/json');
  assert.equal(fetchImpl.calls[0].headers['If-None-Match'], undefined);
});

test('a stored ETag is sent as If-None-Match and 304 means unchanged', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 304 }));
  const res = await api.fetchDayset(zones.getZone('de'), {}, { fetchImpl, userAgent: UA, etag: '"abc"' });
  assert.deepEqual(res, { notModified: true });
  assert.equal(fetchImpl.calls[0].headers['If-None-Match'], '"abc"');
});

test('errors are classified', async () => {
  const run = (r) => api.fetchDayset(zones.getZone('de'), {}, { fetchImpl: fakeFetch(() => r), userAgent: UA, now: () => 1000 });
  await assert.rejects(run({ status: 400 }), { kind: 'nodata' });
  await assert.rejects(run({ status: 404 }), { kind: 'nodata' });
  await assert.rejects(run({ status: 429, headers: { 'Retry-After': '120' } }), { kind: 'rate', retryAfterMs: 120000 });
  await assert.rejects(run({ status: 503 }), { kind: 'server' });
  await assert.rejects(run({ status: 200, badJson: true }), { kind: 'parse' });
  await assert.rejects(run({ status: 200, body: { zone: 'de', days: [] } }), { kind: 'parse' });
  await assert.rejects(run(new Error('getaddrinfo ENOTFOUND')), { kind: 'network' });
});

test('a hung request times out', async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  await assert.rejects(api.fetchDayset(zones.getZone('de'), {}, { fetchImpl, userAgent: UA, timeoutMs: 20 }), { kind: 'timeout' });
});

test('Retry-After as an HTTP date', () => {
  assert.equal(api.retryAfterMs('Wed, 21 Oct 2026 07:28:30 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')), 30000);
  assert.equal(api.retryAfterMs('soon', 0), null);
  assert.equal(api.retryAfterMs(null, 0), null);
});
