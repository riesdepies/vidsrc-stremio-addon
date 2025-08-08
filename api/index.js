const addonInterface = require('../addon.js');

// De handler die Vercel aanroept
const handler = (req, res) => {
  // De addonInterface heeft een ingebouwde router die zich gedraagt als Express-middleware.
  // We roepen deze direct aan en geven de request en response objecten door.
  addonInterface.router(req, res, () => {
    // Dit is de 'next' functie, die wordt aangeroepen als de router de request niet herkent.
    // Dit zou niet moeten gebeuren, maar we eindigen de request netjes.
    res.statusCode = 404;
    res.end('Not Found');
  });
};

module.exports = handler;
