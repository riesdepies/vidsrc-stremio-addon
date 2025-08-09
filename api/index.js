const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('../addon.js');
const fs = require('fs');
const path = require('path');

const router = getRouter(addonInterface);
const logoPath = path.join(__dirname, '..', 'logo.svg');

module.exports = (req, res) => {
  // Voeg CORS headers toe
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  
  // Serveer het logo als daarom wordt gevraagd
  if (req.url === '/logo.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    fs.createReadStream(logoPath).pipe(res);
    return;
  }
  
  // Stuur andere requests door naar de addon router
  res.setHeader('Content-Type', 'application/json');
  router(req, res, () => {
    res.statusCode = 404;
    res.end('Not Found');
  });
};
