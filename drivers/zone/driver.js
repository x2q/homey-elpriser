'use strict';

const Homey = require('homey');

const zones = require('../../lib/zones');

class ZoneDriver extends Homey.Driver {
  async onInit() {
    const flow = this.homey.flow;

    flow
      .getDeviceTriggerCard('price_below')
      .registerRunListener(async (args, st) => st.price < args.threshold && (st.previousPrice === null || st.previousPrice >= args.threshold));
    flow
      .getDeviceTriggerCard('price_above')
      .registerRunListener(async (args, st) => st.price > args.threshold && (st.previousPrice === null || st.previousPrice <= args.threshold));
    flow
      .getDeviceTriggerCard('price_level_changed')
      .registerRunListener(async (args, st) => args.level === 'any' || args.level === st.level);

    flow
      .getConditionCard('in_cheapest_hours')
      .registerRunListener(async (args) => args.device.isAmongCheapest(Math.round(args.hours)));
    flow.getConditionCard('price_below').registerRunListener(async (args) => {
      const price = args.device.getPrice();
      return price !== null && price < args.threshold;
    });
    flow.getConditionCard('price_level_is').registerRunListener(async (args) => args.device.getLevel() === args.level);
  }

  /** The zone picker: every zone the API serves. */
  async onPairListDevices() {
    const language = this.homey.i18n.getLanguage();
    return zones.ZONES.map((zone) => ({
      name: zones.zoneLabel(zone, language),
      data: { id: zone.key },
      store: {},
      settings: { data_source: zones.attribution(zone) ? `elpriser.org - ${zones.attribution(zone)}` : 'elpriser.org' },
    }));
  }
}

module.exports = ZoneDriver;
