const { processAndLog } = require('./src/blockchain');

(async () => {
  const evt = {
    eventId: 't1',
    deviceId: 'esp32-01',
    groupId: 'group-1',
    oldTS: 80,
    newTS: 77,
    reason: 'instability',
    distA: 120,
    distB: 118,
    speed: 0.75,
    ts: Date.now()
  };
  const res = await processAndLog(evt);
  console.log('result:', res);
})();
