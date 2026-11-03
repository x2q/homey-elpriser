'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const prices = require('../lib/prices');
const schedule = require('../lib/schedule');

const MIN = 60000;
const cph = (iso) => Date.parse(iso); // helper: times below are given in UTC; 2026-11-03 CET = UTC+1

test('nothing to show: fetch now', () => {
  const now = cph('2026-11-03T08:00:00Z');
  assert.equal(schedule.nextFetchAt({ now, covered: false, tomorrowPublished: false, latestKnown: false }), now);
});

test('back-off after failures: 5, 10, 20, 40, then 60 minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(schedule.backoffMs), [5, 10, 20, 40, 60, 60].map((m) => m * MIN));
  const now = cph('2026-11-03T08:00:00Z');
  const at = schedule.nextFetchAt({ now, covered: false, tomorrowPublished: false, latestKnown: false, lastAttempt: now, failures: 2 });
  assert.equal(at, now + 10 * MIN);
});

test('Retry-After is honoured', () => {
  const now = cph('2026-11-03T08:00:00Z');
  const at = schedule.nextFetchAt({ now, covered: false, tomorrowPublished: false, latestKnown: false, retryAfter: now + 90 * MIN });
  assert.equal(at, now + 90 * MIN);
});

test('morning with data for today: wait for 13:05 CET + jitter', () => {
  const now = cph('2026-11-03T08:00:00Z'); // 09:00 CET
  const jitter = 3 * MIN;
  const at = schedule.nextFetchAt({ now, covered: true, tomorrowPublished: false, latestKnown: false, jitterMs: jitter });
  assert.equal(new Date(at).toISOString(), '2026-11-03T12:08:00.000Z'); // 13:08 CET
});

test('after 13:05 with tomorrow missing: ask now, then every 20 minutes', () => {
  const now = cph('2026-11-03T12:30:00Z'); // 13:30 CET
  assert.equal(schedule.nextFetchAt({ now, covered: true, tomorrowPublished: false, latestKnown: false }), now);
  const retry = schedule.nextFetchAt({ now, covered: true, tomorrowPublished: false, latestKnown: false, lastAttempt: now - 5 * MIN });
  assert.equal(retry, now + 15 * MIN);
});

test('tomorrow already here: next fetch is the next day at 13:05', () => {
  const now = cph('2026-11-03T14:00:00Z');
  const at = schedule.nextFetchAt({ now, covered: true, tomorrowPublished: true, latestKnown: false });
  assert.equal(new Date(at).toISOString(), '2026-11-04T12:05:00.000Z');
});

test('past the catch-up window (18:00 CET) with tomorrow missing: try again tomorrow at 13:05', () => {
  const now = cph('2026-11-03T18:30:00Z'); // 19:30 CET
  const at = schedule.nextFetchAt({ now, covered: true, tomorrowPublished: false, latestKnown: false });
  assert.equal(new Date(at).toISOString(), '2026-11-04T12:05:00.000Z');
});

test('summer time: 13:05 is 13:05 Copenhagen time, i.e. 11:05 UTC', () => {
  const now = Date.parse('2026-07-01T07:00:00Z');
  const at = schedule.nextFetchAt({ now, covered: true, tomorrowPublished: false, latestKnown: false });
  assert.equal(new Date(at).toISOString(), '2026-07-01T11:05:00.000Z');
});

test('within-day index (gb): once an hour, five minutes past', () => {
  const now = cph('2026-11-03T07:42:00Z');
  const done = cph('2026-11-03T07:06:00Z');
  const at = schedule.nextFetchAt({ now, covered: true, tomorrowPublished: false, latestKnown: true, lastSuccess: done });
  assert.equal(new Date(at).toISOString(), '2026-11-03T08:05:00.000Z');
  const notYet = schedule.nextFetchAt({ now, covered: true, tomorrowPublished: false, latestKnown: true, lastSuccess: cph('2026-11-03T06:30:00Z') });
  assert.equal(notYet, now);
});

test('never asks more than twice a day on an ordinary day', () => {
  // Simulate a day for an always-online device that fetches whenever it is due.
  let now = Date.parse('2026-11-03T00:00:30Z');
  const end = Date.parse('2026-11-04T00:00:00Z');
  let lastAttempt = 0;
  let tomorrow = false;
  const fetches = [];
  while (now < end) {
    const at = schedule.nextFetchAt({ now, covered: true, tomorrowPublished: tomorrow, latestKnown: false, lastAttempt, jitterMs: 2 * MIN });
    if (at >= end) break;
    now = at;
    lastAttempt = now;
    fetches.push(new Date(now).toISOString());
    if (now >= Date.parse('2026-11-03T12:00:00Z')) tomorrow = true; // published at 13:00 CET
  }
  assert.ok(fetches.length <= 2, fetches.join(', '));
});

test('nextHourBoundary', () => {
  assert.equal(schedule.nextHourBoundary(Date.parse('2026-11-03T08:42:10Z')), Date.parse('2026-11-03T09:00:00Z'));
  assert.equal(schedule.nextHourBoundary(Date.parse('2026-11-03T09:00:00Z')), Date.parse('2026-11-03T10:00:00Z'));
  assert.equal(prices.HOUR_MS, 3600000);
});
