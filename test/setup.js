'use strict';

/**
 * `require('homey')` only exists on a Homey. Tests run on plain Node, so
 * `homey` is replaced with a minimal fake of the base classes the app extends.
 */
const Module = require('module');

class FakeHomeyBase {}

class FakeDevice extends FakeHomeyBase {
  constructor({ data = {}, settings = {}, store = {}, capabilities = [], homey } = {}) {
    super();
    this._data = data;
    this._settings = { ...settings };
    this._store = { ...store };
    this._caps = new Map(capabilities.map((c) => [c, null]));
    this._capOptions = {};
    this.homey = homey;
    this.available = true;
    this.unavailableMessage = null;
    this.warning = null;
    this.logs = [];
    this.errors = [];
    this.log = (...a) => this.logs.push(a.join(' '));
    this.error = (...a) => this.errors.push(a.join(' '));
  }

  getData() { return this._data; }
  getSettings() { return { ...this._settings }; }
  async setSettings(s) { Object.assign(this._settings, s); }
  getStoreValue(k) { return this._store[k]; }
  async setStoreValue(k, v) { this._store[k] = JSON.parse(JSON.stringify(v)); }
  hasCapability(c) { return this._caps.has(c); }
  getCapabilityValue(c) { return this._caps.get(c); }
  async setCapabilityValue(c, v) {
    if (!this._caps.has(c)) throw new Error(`Missing capability ${c}`);
    this._caps.set(c, v);
  }
  async setCapabilityOptions(c, o) { this._capOptions[c] = { ...(this._capOptions[c] || {}), ...o }; }
  async setAvailable() { this.available = true; this.unavailableMessage = null; }
  async setUnavailable(m) { this.available = false; this.unavailableMessage = m; }
  async setWarning(m) { this.warning = m; }
  async unsetWarning() { this.warning = null; }
}

class FakeDriver extends FakeHomeyBase {}
class FakeApp extends FakeHomeyBase {}

const fakeHomey = { Device: FakeDevice, Driver: FakeDriver, App: FakeApp };

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') return fakeHomey;
  return originalLoad.call(this, request, ...rest);
};
