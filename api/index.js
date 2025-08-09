const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('../addon.js');

const router = getRouter(addonInterface);

module.exports = (req, res) => {
  // Voeg ALLE vereiste headers toe
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Content-Type', 'application/json'); // <-- DE NIEUWE, CRUCIALE HEADER

  // Behandel 'preflight' OPTIONS requests
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
