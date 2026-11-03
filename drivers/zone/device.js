'use strict';

const Homey = require('homey');

const api = require('../../lib/api');
const prices = require('../../lib/prices');
const schedule = require('../../lib/schedule');
const state = require('../../lib/state');
const zones = require('../../lib/zones');

const SETTLE_MS = 2000; // fire a moment after the hour so every clock agrees it is the new hour
const MAX_TIMER_MS = 2 ** 31 - 1;
const WARN_AFTER_FAILURES = 2;
const NUMBER_CAPABILITIES = ['measure_price', 'measure_price_next', 'measure_price_min', 'measure_price_max', 'measure_price_avg'];

/**
 * One device per price zone. It holds the day set of its zone (today, tomorrow
 * once published, the forecast days) and answers every question locally; it only
 * calls elpriser.org when lib/schedule.js says so (about twice a day).
 */
class ZoneDevice extends Homey.Device {
  async onInit() {
    this._zone = zones.getZone(this.getData().id);
    this._timers = { tick: null, fetch: null };
    this._dayset = null;
    this._requestKey = null;
    this._etag = null;
    this._lastAttempt = 0;
    this._lastSuccess = 0;
    this._failures = 0;
    this._retryAfter = 0;
    this._state = null;
    this._fetching = null;
    this._unavailable = false;
    this._warned = false;
    this._unit = null;
    this._jitterMs = Math.floor(Math.random() * schedule.MAX_JITTER_MS);

    if (!this._zone) {
      await this.setUnavailable(this._t('device.unknown_zone', { zone: String(this.getData().id) }));
      return;
    }

    await this._restoreCache();
    await this._applyCapabilityOptions();
    await this.setSettings({ data_source: this._dataSourceText() }).catch(this.error);

    await this._compute();
    this._scheduleTick();
    this._scheduleFetch();
  }

  async onUninit() {
    this._clearTimers();
  }

  async onDeleted() {
    this._clearTimers();
  }

  // -- settings ----------------------------------------------------------------

  async onSettings({ newSettings, changedKeys }) {
    if (zones.isDanish(this._zone)) {
      const mode = newSettings.price_mode;
      if (!zones.DK_MODES.includes(mode)) throw new Error(this._t('settings.bad_mode'));
      const gln = zones.resolveGln(newSettings);
      if (newSettings.gln_custom && !zones.isValidGln(gln)) throw new Error(this._t('settings.bad_gln'));
      if (zones.NET_MODES.has(mode) && !gln) throw new Error(this._t('settings.need_grid_company'));
    }
    const cheapHours = Number(newSettings.cheap_hours);
    if (!Number.isInteger(cheapHours) || cheapHours < 1 || cheapHours > 12) throw new Error(this._t('settings.bad_cheap_hours'));

    // Homey stores the new values after this method returns; look at them a moment later.
    const refetch = ['price_mode', 'grid_company', 'gln_custom'].some((k) => changedKeys.includes(k));
    this.homey.setTimeout(() => {
      Promise.resolve(refetch ? this._onRequestChanged() : this._compute({ fire: false })).catch(this.error);
    }, 100);
  }

  async _onRequestChanged() {
    this._dayset = null;
    this._etag = null;
    this._requestKey = null;
    this._failures = 0;
    this._retryAfter = 0;
    await this._compute({ fire: false });
    this._scheduleFetch();
  }

  _settingsNow() {
    return this.getSettings() || {};
  }

  _requestOptions() {
    if (!zones.isDanish(this._zone)) return {};
    const settings = this._settingsNow();
    return { mode: settings.price_mode || 'inkl_alt', gln: zones.resolveGln(settings) || undefined };
  }

  _cheapHours() {
    const n = Number(this._settingsNow().cheap_hours);
    return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 4;
  }

  // -- clock and timers (overridable in tests) -----------------------------------

  _now() {
    return Date.now();
  }

  _clearTimers() {
    for (const key of Object.keys(this._timers || {})) {
      if (this._timers[key]) this.homey.clearTimeout(this._timers[key]);
      this._timers[key] = null;
    }
  }

  _scheduleTick() {
    if (this._timers.tick) this.homey.clearTimeout(this._timers.tick);
    const now = this._now();
    const delay = schedule.nextHourBoundary(now) - now + SETTLE_MS;
    this._timers.tick = this.homey.setTimeout(() => {
      this._timers.tick = null;
      this._onHour().catch(this.error);
    }, delay);
  }

  async _onHour() {
    try {
      await this._compute({ fire: true });
    } finally {
      this._scheduleTick();
      this._scheduleFetch();
    }
  }

  _scheduleFetch() {
    if (this._timers.fetch) this.homey.clearTimeout(this._timers.fetch);
    const now = this._now();
    const st = this._state || {};
    const at = schedule.nextFetchAt({
      now,
      covered: Boolean(st.covered && this._dayset),
      tomorrowPublished: Boolean(st.tomorrowPublished),
      latestKnown: this._zone.latestKnown,
      lastAttempt: this._lastAttempt,
      lastSuccess: this._lastSuccess,
      failures: this._failures,
      retryAfter: this._retryAfter,
      jitterMs: this._jitterMs,
    });
    const delay = Math.min(Math.max(at - now, 0), MAX_TIMER_MS);
    this._timers.fetch = this.homey.setTimeout(() => {
      this._timers.fetch = null;
      this._refresh().catch(this.error);
    }, delay);
  }

  // -- talking to elpriser.org ----------------------------------------------------

  _userAgent() {
    const version = (this.homey.manifest && this.homey.manifest.version) || 'dev';
    return `Homey-elpriser/${version} (+https://github.com/x2q/homey-elpriser)`;
  }

  async _refresh() {
    if (this._fetching) return this._fetching;
    this._fetching = this._doFetch().finally(() => {
      this._fetching = null;
    });
    return this._fetching;
  }

  async _doFetch() {
    const options = this._requestOptions();
    const key = api.requestUrl(this._zone, options);
    this._lastAttempt = this._now();
    try {
      const result = await api.fetchDayset(this._zone, options, {
        userAgent: this._userAgent(),
        etag: this._etag && this._requestKey === key ? this._etag : null,
        fetchImpl: this._fetchImpl,
        now: () => this._now(),
      });
      this._lastSuccess = this._now();
      this._failures = 0;
      this._retryAfter = 0;
      if (!result.notModified) {
        this._dayset = result.dayset;
        this._etag = result.etag;
        this._requestKey = key;
        await this._saveCache();
      }
      if (this._warned) {
        this._warned = false;
        await this.unsetWarning().catch(this.error);
      }
    } catch (err) {
      this._failures += 1;
      this._retryAfter = err instanceof api.ApiError && err.retryAfterMs ? this._now() + err.retryAfterMs : 0;
      this.error(`Fetching prices for ${this._zone.key} failed (${err.kind || 'error'}): ${err.message}`);
    }
    try {
      await this._compute({ fire: true });
    } finally {
      this._scheduleFetch();
    }
  }

  async _saveCache() {
    const keep = (this._dayset.days || []).slice(-12);
    await this.setStoreValue('cache', {
      key: this._requestKey,
      etag: this._etag,
      fetchedAt: this._lastSuccess,
      dayset: { ...this._dayset, days: keep },
    }).catch(this.error);
  }

  async _restoreCache() {
    const cache = this.getStoreValue('cache');
    if (!cache || !cache.dayset || !Array.isArray(cache.dayset.days)) return;
    // A cache made for other settings (mode, grid company) is of no use.
    if (cache.key !== api.requestUrl(this._zone, this._requestOptions())) return;
    this._dayset = cache.dayset;
    this._etag = cache.etag || null;
    this._requestKey = cache.key;
    this._lastSuccess = Number(cache.fetchedAt) || 0;
  }

  // -- state -----------------------------------------------------------------------

  async _compute({ fire = this._state !== null } = {}) {
    const now = this._now();
    const previous = this._state;
    const next = this._dayset
      ? state.computeState(this._dayset, this._zone, now, { cheapHours: this._cheapHours() })
      : { covered: false, slotStart: null, tomorrowPublished: false };
    this._state = next;

    if (!next.covered) {
      await this._showNoData();
      return;
    }
    if (this._unavailable) {
      this._unavailable = false;
      await this.setAvailable().catch(this.error);
    }
    await this._applyUnit(next.unit);

    await this._set('measure_price', next.price);
    await this._set('measure_price_next', next.nextPrice);
    await this._set('measure_price_min', next.min);
    await this._set('measure_price_max', next.max);
    await this._set('measure_price_avg', next.avg);
    await this._set('price_level', next.level);
    await this._set('cheap_hour_now', next.cheapHourNow);
    await this._set('cheapest_hour_start', next.cheapestStart === null ? null : this._formatHour(next.cheapestStart));

    if (this._failures >= WARN_AFTER_FAILURES && !this._warned) {
      this._warned = true;
      await this.setWarning(this._t('warning.offline')).catch(this.error);
    }

    if (fire && previous) await this._fireTriggers(state.diffEvents(previous, next), next);
  }

  async _showNoData() {
    for (const cap of ['measure_price', 'measure_price_next', 'measure_price_min', 'measure_price_max', 'measure_price_avg', 'price_level', 'cheap_hour_now', 'cheapest_hour_start']) {
      await this._set(cap, null);
    }
    if (!this._unavailable) {
      this._unavailable = true;
      await this.setUnavailable(this._t(this._failures > 0 ? 'device.no_data_offline' : 'device.no_data')).catch(this.error);
    }
  }

  async _set(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  async _applyCapabilityOptions() {
    if (this._dayset) await this._applyUnit(this._dayset.unit);
  }

  async _applyUnit(unit) {
    if (!unit || this._unit === unit) return;
    this._unit = unit;
    for (const cap of NUMBER_CAPABILITIES) {
      if (this.hasCapability(cap)) await this.setCapabilityOptions(cap, { units: unit }).catch(this.error);
    }
  }

  _formatHour(ms) {
    return `${String(prices.localHour(ms, this._zone.tz)).padStart(2, '0')}:00`;
  }

  _dataSourceText() {
    const attribution = zones.attribution(this._zone);
    return attribution ? `elpriser.org - ${attribution}` : 'elpriser.org';
  }

  _t(key, tokens) {
    return this.homey.__(key, tokens);
  }

  async _fireTriggers(events, next) {
    if (!events.hourChanged) return;
    const fire = (id, tokens, st) => this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens, st).catch(this.error);
    const hour = prices.localHour(next.slotStart, this._zone.tz);
    await fire('price_below', { price: next.price }, events.belowAbove);
    await fire('price_above', { price: next.price }, events.belowAbove);
    if (events.cheapestHourStarts) await fire('cheapest_hour_starts', { price: next.price, hour }, {});
    if (events.cheapHourStarted) await fire('cheap_hour_starts', { price: next.price, hour }, {});
    if (events.levelChanged) {
      await fire(
        'price_level_changed',
        { level: events.levelChanged.level, previous_level: events.levelChanged.previousLevel || '', price: next.price },
        { level: events.levelChanged.level },
      );
    }
  }

  // -- used by the flow cards (driver.js) ------------------------------------------

  /** True/false, or false when the answer is not known. */
  isAmongCheapest(count) {
    if (!this._dayset) return false;
    return state.isAmongCheapest(this._dayset, this._zone, this._now(), count) === true;
  }

  getPrice() {
    return this._state && this._state.covered ? this._state.price : null;
  }

  getLevel() {
    return this._state && this._state.covered ? this._state.level : null;
  }
}

module.exports = ZoneDevice;
