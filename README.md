# Elpriser for Homey

[![Tests](https://github.com/x2q/homey-elpriser/actions/workflows/tests.yml/badge.svg)](https://github.com/x2q/homey-elpriser/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Hourly electricity prices from [elpriser.org](https://elpriser.org) as a Homey app: the price right now and next
hour, today's lowest / highest / average, a cheap / normal / expensive level, a "cheap hour" switch, and flow cards
for "run it when power is cheap".

> **Status: unofficial, unpublished, not yet run on a real Homey.** The logic is covered by unit tests against
> recorded live responses and the manifest validates at `publish` level with the Homey CLI, but nobody has paired
> this app on a Homey Pro yet. It is not in the Homey App Store; install it from source (below) and please report what you find.

* **40 price zones**: Denmark (DK1 and DK2, optionally with your grid company's tariff), the other Nordic and Dutch
  zones, and most of continental Europe, Great Britain and Ireland. One device per zone.
* **Free, no account, no API key, no telemetry.** The app only talks to `elpriser.org`.
* **Gentle on the service**: about two requests per zone per day (more below).
* Danish and English.

Sister projects: [ha-elpriser](https://github.com/x2q/ha-elpriser) (Home Assistant),
[esphome-elpriser](https://github.com/x2q/esphome-elpriser) (ESPHome).

## Install (from source)

You need a Homey Pro (SDK v3 app, Homey firmware 12.2.0 or newer) and Node.js 18 or newer.

```bash
git clone https://github.com/x2q/homey-elpriser.git
cd homey-elpriser
npm install
npx homey login                # once
npx homey app run              # development mode, logs in your terminal (needs Docker, or add --remote)
# or install it permanently on your Homey:
npx homey app install
```

Then in the Homey app: **Devices -> + -> Elpriser -> pick your price zone.**

The app declares the platform `local` only (Homey Pro / Self-Hosted Server), not Homey Cloud.

## Set-up

Pick a zone in the list. Add one device per zone you care about. Device **settings**:

| Setting | What it does |
| --- | --- |
| Number of cheap hours (default 4) | The "Cheap hour" switch is on while the current hour is one of today's N cheapest. |
| Price type (Denmark only) | `inkl_alt` (default): spot + Energinet's system and transmission tariffs + electricity tax + 25 % VAT, i.e. everything except your own grid company's tariff. `spot_inkl` / `spot_ex`: the raw spot price with / without VAT. `net_inkl_alt`: **the full price you pay**, including your grid company's tariff. More variants are in the list. |
| Grid company (Denmark only) | Needed for the `net_*` price types. Pick from the list or type a 13-digit GLN number. |

Every other zone shows the **wholesale (day-ahead) price without VAT, taxes and grid fees** in the zone's local
currency (converted with the ECB reference rate) - not what a household pays.

## What the device shows

| Capability | Content |
| --- | --- |
| Price now | The price of the current hour, in `<currency>/kWh` (for example `DKK/kWh`, `EUR/kWh`, `SEK/kWh`). Logged in Insights. |
| Price next hour | The price of the next hour (empty until it is published). |
| Lowest / highest / average today | Over the hours of today (the zone's own calendar day). |
| Price level | `cheap`, `normal` or `expensive`: the current price within today's range (lowest third / middle / highest third; a flat day is `normal`). |
| Cheap hour | On while the current hour is one of today's N cheapest. |
| Cheapest hour | When today's cheapest hour starts (`HH:00`, on the zone's clock). |

Live example (2026-11-03, 08:55 CET, from `npm run live`):

| Zone | Price now | Next hour | Today min / max / avg | Level |
| --- | --- | --- | --- | --- |
| DK1, `inkl_alt` | 2.9896 DKK/kWh | 2.706 | 2.209 / 3.0903 / 2.52244 | expensive |
| DE | 0.30131 EUR/kWh | 0.27094 | 0.22207 / 0.31358 / 0.25285 | expensive |
| SE3 | 2.31594 SEK/kWh | 2.01773 | 0.98626 / 3.1138 / 1.84755 | normal |

Only **settled** prices are ever shown. The service also publishes a statistical forecast for the coming days (not
an official forecast); this app deliberately ignores it, so a forecast is never presented as "the price".

### Great Britain

`gb` is not a day-ahead price: it is the within-day **Market Index Price** from Elexon BMRS in GBP, and an hour is
only priced once it is over. So "Price now" shows the **last complete hour** (for at most three hours), "Price next
hour", "Cheap hour" and "Cheapest hour" stay empty, and the cheap-hour flow cards never match for `gb`.

## Flow cards

**Triggers** (all fire at the start of an hour; they never fire from a refresh in the middle of an hour):

* *The price drops below / rises above a value* - when the price of the new hour is below (above) the value and the
  previous hour's was not. Token: price. The value is in the zone's currency per kWh.
* *The cheapest hour of the day starts* - once a day. Tokens: price, hour.
* *A cheap hour starts* - the new hour is one of the N cheapest (device setting) and the previous one was not.
* *The price level changed* - optionally only to a given level. Tokens: level, previous level, price.

**Conditions** (can be inverted in the flow editor):

* *The current hour is among the N cheapest hours of today* (N = 1-23). False if the price of this hour is not known.
* *The price now is below a value.*
* *The price level is cheap / normal / expensive.*

Example: **When** a cheap hour starts, **and** the water heater temperature is below 60, **then** turn the heater on.
After a restart of the app or Homey no trigger fires for the hour that is already running; the conditions work at once.

## Polling and the API

elpriser.org is a free service that is edge-cached for 30-60 minutes. The whole day set (today, tomorrow once it is
published, the forecast days) comes in **one response per zone**, and "now" is picked locally at every hour boundary:

* **No polling for "now"**: the device recomputes its values at each full hour (+2 seconds) from the data it holds.
* A request when there is nothing to show for the current hour (first start, a new day without data).
* One request at about **13:05 CET plus a random 0-5 minutes**, when tomorrow's prices are published; if they are not
  there yet, again every 20 minutes until 18:00 CET, otherwise the next day.
* `gb` only: one request per hour (five minutes past, plus the jitter), because an hour is priced once it is over.
* Conditional requests (`If-None-Match` / `ETag`), so an unchanged answer costs a `304`.
* **Back-off on errors** (5, 10, 20, 40, then 60 minutes; `Retry-After` is honoured).
* A `User-Agent` of `Homey-elpriser/<version>`; a 30 second timeout. The held prices are kept in the device store, so
  a restart does not cost a request.

Nothing is sent except the zone (and for Denmark the price type and the optional grid company GLN) in the request URL.

### When elpriser.org cannot be reached

Day-ahead prices are published a day ahead, so the data you already hold stays correct for the day it was published
for. The device keeps showing it and flows keep working; after two failed requests it shows a warning. When the held data
no longer covers the current hour (for example the service has been down since yesterday afternoon) the device
becomes **unavailable** with an explanation and **no trigger fires and every condition is false**: it never
acts on a price it does not have.

## Data sources and licences

Prices are served by elpriser.org from Energi Data Service (Energinet), ENTSO-E, Energy-Charts, SEMOpx and Elexon.
Zones taken from Bundesnetzagentur | SMARD.de via Energy-Charts.info (CC BY 4.0) carry that attribution (the hourly
means of the 15-minute prices, changed); `gb` carries *Contains BMRS data © Elexon Limited copyright and database
right <year>*. Both notices are shown in the device settings ("Data source"). See [elpriser.org](https://elpriser.org)
for the details per zone.

## Development

```bash
npm install
npm test                      # 60+ unit tests against recorded live responses (test/fixtures), plain Node
npm run validate              # homey app validate (app.json is generated from .homeycompose)
npm run validate:publish      # the same at publish level
npm run live                  # real requests; prints what the device would show; checks the zone list against the live API
```

`require('homey')` only exists on a Homey, so the tests replace it with a minimal fake (`test/setup.js`). The logic
lives in `lib/` without any Homey imports: `prices.js` (parsing, daylight saving time), `state.js` (what the
device shows, which triggers fire), `schedule.js` (when to ask the API), `api.js` (the client).

`app.json` is produced from `.homeycompose/` by the Homey CLI and is committed because the CLI wants it present; edit the
compose files, then run `npm run validate`.

The zone table in `lib/zones.js` mirrors the zone list of the elpriser.org API (a test compares it with a recorded
`/api/openapi.json`, `npm run live` with the live one). The Danish grid company list is copied from the Home
Assistant integration: keep them in sync when the service adds a zone or a company.

### Before this could go in the Homey App Store

Not done, and not claimed: the app has to pass Homey's review (certification), which needs an app that has run on a
real Homey, an App Store developer account and a submission through `homey app publish`; store images and texts need a human
look (the images here are placeholders); and `homey app review` should be run. Homey Cloud (`cloud` platform) would need
its own review of the restrictions.

## Support

Issues and pull requests: <https://github.com/x2q/homey-elpriser/issues>. MIT licensed.

## På dansk

Elpriser for Homey henter elprisen time for time fra [elpriser.org](https://elpriser.org) til 40 prisområder (DK1, DK2,
resten af Norden, Holland, Tyskland m.fl.). Du får prisen nu og næste time, dagens laveste, højeste og gennemsnit,
et prisniveau (billig/normal/dyr), en "billig time"-kontakt og flowkort: *prisen falder under/stiger over en værdi*,
*dagens billigste time starter*, *en billig time starter*, *prisniveauet ændrede sig* samt betingelser som *den aktuelle
time er blandt de N billigste*. For Danmark kan du vælge pristype og netselskab og dermed få hele prisen inkl. nettarif.
Uden for Danmark er det børsprisen uden moms, afgifter og nettarif. Appen er uofficiel, ikke udgivet i Homey App Store og
endnu ikke afprøvet på en rigtig Homey; installér den fra kildekoden (se ovenfor). Gratis, ingen konto og ingen API-nøgle;
appen spørger elpriser.org cirka to gange i døgnet pr. zone. Hvis elpriser.org ikke kan nås, bruges de allerede hentede
priser, så længe de dækker den aktuelle time; derefter bliver enheden utilgængelig og ingen flow udløses.
