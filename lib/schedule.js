'use strict';

const prices = require('./prices');

/**
 * When does a device next need to ask elpriser.org? Pure - the device just sleeps
 * until the returned instant.
 *
 * Etiquette (the service is free and edge-cached for 30-60 minutes): the whole
 * day set comes in ONE response and "now" is picked locally at every hour
 * boundary, so a zone costs about two requests per day:
 *  - one when there is nothing to show for the current hour (start-up, new day
 *    without data), and
 *  - one shortly after the day-ahead prices come out (13:00 CET) plus a random
 *    0-5 minute jitter, repeated every 20 minutes until 18:00 if tomorrow is
 *    still missing.
 * The only exception is a within-day index (gb) where an hour is only priced once
 * it is over: one request per hour, five minutes past plus the jitter.
 * After a failure: back off 5, 10, 20, 40, then 60 minutes; Retry-After is honoured.
 */

const MIN_MS = 60 * 1000;
const CPH = 'Europe/Copenhagen';
const PUBLISH_HOUR = 13;
const PUBLISH_MINUTE = 5;
const CATCH_UP_END_HOUR = 18;
const CATCH_UP_MS = 20 * MIN_MS;
const LATEST_KNOWN_DELAY_MS = 5 * MIN_MS;
const BACKOFF_MS = [5, 10, 20, 40, 60].map((m) => m * MIN_MS);
const MAX_JITTER_MS = 5 * MIN_MS;

function backoffMs(failures) {
  if (failures <= 0) return 0;
  return BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1];
}

/**
 * @param {object} i
 * @param {number} i.now              epoch ms
 * @param {boolean} i.covered         does the held data cover the current hour?
 * @param {boolean} i.tomorrowPublished  does it hold settled prices for tomorrow?
 * @param {boolean} i.latestKnown     within-day index (gb)
 * @param {number} [i.lastAttempt]    epoch ms of the last request (0 = never)
 * @param {number} [i.lastSuccess]    epoch ms of the last good answer (0 = never)
 * @param {number} [i.failures]       consecutive failed requests
 * @param {number} [i.retryAfter]     epoch ms before which the server asked us not to come back
 * @param {number} [i.jitterMs]       0..MAX_JITTER_MS, fixed per device
 * @returns {number} epoch ms (>= now)
 */
function nextFetchAt(i) {
  const { now, covered, tomorrowPublished, latestKnown } = i;
  const lastAttempt = i.lastAttempt || 0;
  const lastSuccess = i.lastSuccess || 0;
  const failures = i.failures || 0;
  const jitter = Math.min(Math.max(i.jitterMs || 0, 0), MAX_JITTER_MS);
  const retryNotBefore = Math.max(i.retryAfter || 0, failures > 0 ? lastAttempt + backoffMs(failures) : 0);

  // Nothing to show for this hour: ask as soon as we are allowed to.
  if (!covered) return Math.max(now, retryNotBefore);

  if (latestKnown) {
    const hourStart = Math.floor(now / prices.HOUR_MS) * prices.HOUR_MS;
    const due = hourStart + LATEST_KNOWN_DELAY_MS + jitter;
    const doneThisHour = lastSuccess >= hourStart + LATEST_KNOWN_DELAY_MS;
    const t = doneThisHour ? due + prices.HOUR_MS : due;
    return Math.max(now, t, retryNotBefore);
  }

  const cphDate = prices.localDate(now, CPH);
  const midnight = prices.localMidnight(cphDate, CPH);
  const publishToday = midnight + PUBLISH_HOUR * prices.HOUR_MS + PUBLISH_MINUTE * MIN_MS + jitter;
  const windowEnd = midnight + CATCH_UP_END_HOUR * prices.HOUR_MS;

  if (!tomorrowPublished) {
    if (now < publishToday) return Math.max(publishToday, retryNotBefore);
    if (now < windowEnd) return Math.max(now, retryNotBefore, lastAttempt + CATCH_UP_MS);
    // Past the catch-up window: try again after tomorrow's publication time.
  }
  const nextDay = prices.localMidnight(prices.addDays(cphDate, 1), CPH);
  const publishNext = now < publishToday && !tomorrowPublished ? publishToday : nextDay + PUBLISH_HOUR * prices.HOUR_MS + PUBLISH_MINUTE * MIN_MS + jitter;
  return Math.max(now, publishNext, retryNotBefore);
}

/** Epoch ms of the next full hour after `now`. */
function nextHourBoundary(now) {
  return (Math.floor(now / prices.HOUR_MS) + 1) * prices.HOUR_MS;
}

module.exports = { nextFetchAt, nextHourBoundary, backoffMs, MAX_JITTER_MS, CATCH_UP_MS, BACKOFF_MS };
