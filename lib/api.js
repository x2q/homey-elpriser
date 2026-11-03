'use strict';

const prices = require('./prices');

const API_BASE = 'https://elpriser.org/api';
const TIMEOUT_MS = 30 * 1000;

/** kind: network | timeout | nodata | rate | server | parse */
class ApiError extends Error {
  constructor(kind, message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Path and query of the request for a zone. Denmark: /forecast, everything else: /nordic. */
function buildRequest(zone, { mode, gln } = {}) {
  if (zone.area) {
    const params = new URLSearchParams({ area: zone.area, mode: mode || 'inkl_alt' });
    if (gln) params.set('gln', gln);
    return { path: '/forecast', params };
  }
  return { path: '/nordic', params: new URLSearchParams({ zone: zone.key }) };
}

function requestUrl(zone, options) {
  const { path, params } = buildRequest(zone, options);
  return `${API_BASE}${path}?${params.toString()}`;
}

function retryAfterMs(header, now) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function parse(zone, payload) {
  return zone.area ? prices.parseForecast(payload, zone.key, zone.area) : prices.parseNordic(payload, zone.key);
}

/**
 * GET the day set of one zone.
 *
 * @returns {Promise<{notModified: true} | {notModified: false, dayset: object, etag: string|null}>}
 * @throws {ApiError}
 */
async function fetchDayset(zone, options = {}, { fetchImpl = globalThis.fetch, userAgent, etag = null, timeoutMs = TIMEOUT_MS, now = Date.now } = {}) {
  const url = requestUrl(zone, options);
  const headers = { 'User-Agent': userAgent, Accept: 'application/json' };
  if (etag) headers['If-None-Match'] = etag;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { headers, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new ApiError('timeout', 'request timed out');
    throw new ApiError('network', err && err.message ? err.message : 'network error');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 304) return { notModified: true };
  if (response.status === 400 || response.status === 404) {
    throw new ApiError('nodata', `HTTP ${response.status} for ${zone.key}`, { status: response.status });
  }
  if (response.status === 429) {
    throw new ApiError('rate', 'rate limited', { status: 429, retryAfterMs: retryAfterMs(response.headers.get('Retry-After'), now()) });
  }
  if (response.status >= 400) {
    throw new ApiError('server', `HTTP ${response.status}`, {
      status: response.status,
      retryAfterMs: retryAfterMs(response.headers.get('Retry-After'), now()),
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    throw new ApiError('parse', 'response is not JSON');
  }
  try {
    return { notModified: false, dayset: parse(zone, payload), etag: response.headers.get('ETag') };
  } catch (err) {
    if (err instanceof prices.PriceDataError) throw new ApiError('parse', err.message);
    throw err;
  }
}

module.exports = { API_BASE, ApiError, buildRequest, requestUrl, fetchDayset, retryAfterMs };
