'use strict';

const Homey = require('homey');

class ElpriserApp extends Homey.App {
  async onInit() {
    this.log('Elpriser started');
  }
}

module.exports = ElpriserApp;
