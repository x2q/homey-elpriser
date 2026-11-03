Elpriser brings the hourly electricity price from elpriser.org into Homey.

Add a device for the price zone you live in (40 zones: Denmark DK1 and DK2, Norway, Sweden, Finland, the Netherlands, Germany, France, Spain, Poland, Great Britain, Ireland and most of continental Europe) and use:

- the price now, the next hour's price and today's lowest, highest and average price, in the zone's currency per kWh
- a price level (cheap, normal or expensive) and a "cheap hour" switch
- flow triggers: the price drops below or rises above a value, the cheapest hour of the day starts, a cheap hour starts, the price level changed
- flow conditions: the current hour is among the N cheapest hours of today, the price is below a value, the price level is

Denmark: pick the price type and, optionally, your grid company (netselskab) to get the full price incl. the grid tariff.

Outside Denmark the app shows the wholesale (day-ahead) price without VAT, taxes and grid fees, so it is not what a household pays. Great Britain is the within-day market index and is shown for the last complete hour.

Free, no account, no API key. The app only talks to elpriser.org, about twice a day per zone.
