const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('../addon.js');

// Maak de router aan door de interface aan de getRouter functie te geven
const router = getRouter(addonInterface);

// Exporteer de handler die Vercel aanroept
module.exports = (req, res) => {
  router(req, res, () => {
    // Fallback voor als de router de request niet herkent
    res.statusCode = 404;
    res.end('Not Found');
  });
};
