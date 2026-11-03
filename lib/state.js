'use strict';

const prices = require('./prices');

// A source that is only known for hours that have already passed (gb) may keep
// showing its last complete hour for at most this long.
const LATEST_KNOWN_MAX_AGE_MS = 3 * prices.HOUR_MS;

function isPriced(slot) {
  return Boolean(slot) && slot.kind === prices.KIND_ACTUAL && slot.value !== null;
}

/**
 * Everything the device shows, computed locally from a parsed day set. Pure.
 *
 * Only settled ("actual") prices count: an hour that is only a model forecast
 * is never presented as the price, the next hour, or part of a daily statistic.
 *
 * @param {object} dayset  from prices.parseNordic / parseForecast
 * @param {object} zone    entry of zones.js
 * @param {number} now     epoch ms
 * @param {{cheapHours?: number}} [options]
 */
function computeState(dayset, zone, now, options = {}) {
  const cheapHours = options.cheapHours ?? 4;
  const tz = zone.tz;
  const slots = prices.expandSlots(dayset, tz);
  const today = prices.localDate(now, tz);
  const tomorrow = prices.addDays(today, 1);
  const todaySlots = prices.slotsOn(slots, today, tz);
  const stats = prices.dayStats(todaySlots);

  const current = prices.slotContaining(slots, now);
  let priceSlot = isPriced(current) ? current : null;
  let isLatestKnown = false;
  if (!priceSlot && zone.latestKnown) {
    const past = prices.settled(slots).filter((s) => s.end <= now && now - s.end <= LATEST_KNOWN_MAX_AGE_MS);
    priceSlot = past.length ? past[past.length - 1] : null;
    isLatestKnown = priceSlot !== null;
  }

  const upcoming = current ? slots.find((s) => s.start === current.end) : null;
  const nextPrice = isPriced(upcoming) ? upcoming.value : null;

  const cheapest = zone.latestKnown ? [] : prices.cheapestSlots(todaySlots, cheapHours);
  const cheapestOne = zone.latestKnown ? null : prices.cheapestSlots(todaySlots, 1)[0] || null;

  return {
    covered: priceSlot !== null,
    slotStart: priceSlot ? priceSlot.start : null,
    isLatestKnown,
    price: priceSlot ? priceSlot.value : null,
    nextPrice,
    min: stats ? stats.minimum.value : null,
    max: stats ? stats.maximum.value : null,
    avg: stats ? stats.average : null,
    level: priceSlot ? prices.priceLevel(priceSlot.value, stats) : null,
    // null = unknown (no price for this hour, or a within-day index that has no future)
    cheapHourNow: zone.latestKnown || !priceSlot ? null : cheapest.some((s) => s.start === priceSlot.start),
    cheapestStart: cheapestOne ? cheapestOne.start : null,
    isCheapestHourNow: Boolean(priceSlot && cheapestOne && !isLatestKnown && cheapestOne.start === priceSlot.start),
    tomorrowPublished: prices.settled(prices.slotsOn(slots, tomorrow, tz)).length > 0,
    currency: dayset.currency,
    unit: dayset.unit,
  };
}

/**
 * Is the current hour one of today's `count` cheapest? null if that cannot be
 * known (no price for this hour, or a within-day index such as gb).
 */
function isAmongCheapest(dayset, zone, now, count) {
  if (zone.latestKnown) return null;
  const slots = prices.expandSlots(dayset, zone.tz);
  const current = prices.slotContaining(slots, now);
  if (!isPriced(current)) return null;
  const today = prices.slotsOn(slots, prices.localDate(now, zone.tz), zone.tz);
  return prices.cheapestSlots(today, count).some((s) => s.start === current.start);
}

/**
 * Which flow triggers a change from `prev` to `next` state should fire. Pure.
 * Triggers only fire when the hour has moved on (`next.slotStart !== prev.slotStart`),
 * never because a data refresh changed a number inside the same hour.
 */
function diffEvents(prev, next) {
  const events = { hourChanged: false, belowAbove: null, cheapestHourStarts: false, cheapHourStarted: false, levelChanged: null };
  if (!prev || !next || !next.covered || next.slotStart === prev.slotStart) return events;
  events.hourChanged = true;
  events.belowAbove = { price: next.price, previousPrice: prev.price };
  events.cheapestHourStarts = next.isCheapestHourNow;
  events.cheapHourStarted = next.cheapHourNow === true && prev.cheapHourNow !== true;
  if (next.level && next.level !== prev.level) events.levelChanged = { level: next.level, previousLevel: prev.level };
  return events;
}

module.exports = { computeState, isAmongCheapest, diffEvents, LATEST_KNOWN_MAX_AGE_MS };
