'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const zones = require('../lib/zones');
const { fixture } = require('./helpers');

const root = path.join(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

test('the zone table equals the zone enum of the recorded /api/openapi.json', () => {
  const spec = fixture('openapi.json');
  const nordic = spec.paths['/api/nordic'].get.parameters.find((p) => p.name === 'zone').schema.enum;
  assert.deepEqual(zones.ZONES.map((z) => z.key), nordic);
  assert.equal(zones.ZONES.length, 40);
});

test('the Danish price modes equal the enum of the spec', () => {
  const spec = fixture('openapi.json');
  const modes = spec.paths['/api/forecast'].get.parameters.find((p) => p.name === 'mode').schema.enum;
  assert.deepEqual([...zones.DK_MODES].sort(), [...modes].sort());
});

test('every zone has a valid IANA time zone and labels in both languages', () => {
  for (const z of zones.ZONES) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: z.tz }), z.key);
    assert.ok(z.label.en && z.label.da, z.key);
  }
  assert.deepEqual(zones.ZONES.filter((z) => zones.isDanish(z)).map((z) => z.area), ['DK1', 'DK2']);
  assert.deepEqual(zones.ZONES.filter((z) => z.latestKnown).map((z) => z.key), ['gb']);
});

test('grid companies: 13-digit GLN numbers, no duplicates, and the settings dropdown lists them all', () => {
  const glns = zones.DK_GRID_COMPANIES.map((c) => c[1]);
  assert.equal(new Set(glns).size, glns.length);
  for (const g of glns) assert.ok(zones.isValidGln(g), g);
  const settings = readJson('drivers/zone/driver.settings.compose.json');
  const group = settings.find((s) => s.type === 'group');
  const dropdown = group.children.find((c) => c.id === 'grid_company');
  assert.deepEqual(dropdown.values.map((v) => v.id), ['none', ...glns]);
  const modes = group.children.find((c) => c.id === 'price_mode');
  assert.deepEqual(modes.values.map((v) => v.id), zones.DK_MODES);
});

test('resolveGln: a typed GLN wins over the dropdown', () => {
  assert.equal(zones.resolveGln({ grid_company: 'none', gln_custom: '' }), '');
  assert.equal(zones.resolveGln({ grid_company: '5790000705689', gln_custom: '' }), '5790000705689');
  assert.equal(zones.resolveGln({ grid_company: '5790000705689', gln_custom: ' 5790001089030 ' }), '5790001089030');
  assert.equal(zones.isValidGln('123'), false);
});

test('attribution notes only for the sources that require one', () => {
  assert.match(zones.attribution(zones.getZone('de')), /Energy-Charts\.info, CC BY 4\.0/);
  assert.match(zones.attribution(zones.getZone('gb'), 2026), /Elexon Limited copyright and database right 2026/);
  assert.equal(zones.attribution(zones.getZone('no1')), '');
});

test('the manifest is consistent: every flow card and capability the code uses is declared', () => {
  const app = readJson('app.json');
  const ids = (list) => new Set(Array.isArray(list) ? list.map((c) => c.id) : Object.keys(list));
  const triggers = ids(app.flow.triggers);
  const conditions = ids(app.flow.conditions);
  for (const id of ['price_below', 'price_above', 'cheapest_hour_starts', 'cheap_hour_starts', 'price_level_changed']) assert.ok(triggers.has(id), id);
  for (const id of ['in_cheapest_hours', 'price_below', 'price_level_is']) assert.ok(conditions.has(id), id);
  const driver = (Array.isArray(app.drivers) ? app.drivers : []).find((d) => d.id === 'zone');
  assert.ok(driver);
  const caps = ids(app.capabilities);
  for (const c of driver.capabilities) assert.ok(caps.has(c), c);
  assert.equal(app.sdk, 3);
});

test('Danish and English strings exist for every locale key', () => {
  const flat = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  assert.deepEqual(flat(readJson('locales/da.json')).sort(), flat(readJson('locales/en.json')).sort());
});

test('app.json is the current output of .homeycompose (run `npx homey app validate` to regenerate)', () => {
  // The CLI rebuilds app.json from .homeycompose; a stale committed copy would ship old cards.
  const compose = readJson('.homeycompose/app.json');
  const app = readJson('app.json');
  for (const key of ['id', 'version', 'sdk', 'compatibility']) assert.equal(app[key], compose[key], key);
});
