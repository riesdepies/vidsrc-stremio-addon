const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('../addon.js');

const router = getRouter(addonInterface);

module.exports = (req, res) => {
  // Voeg hier de CORS headers toe
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

  // Behandel 'preflight' OPTIONS requests die browsers sturen voor CORS checks
  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  // Geef de request door aan de addon router
  router(req, res, () => {
    res.statusCode = 404;
    res.end('Not Found');
  });
};
