'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/** A fetch() stand-in that serves canned answers and records the calls. */
function fakeFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers, signal: init.signal });
    const r = await responder(url, init, calls.length);
    if (r instanceof Error) throw r;
    const headers = new Map(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: r.status ?? 200,
      headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      json: async () => {
        if (r.badJson) throw new SyntaxError('Unexpected token <');
        return r.body;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

module.exports = { fixture, fakeFetch };
