const { serveHTTP } = require('stremio-addon-sdk');
const addonInterface = require('../addon.js'); // Gaat één map omhoog om addon.js te vinden

// Deze handler wordt door Vercel aangeroepen voor elk request
const handler = (req, res) => {
    serveHTTP(addonInterface, { req, res });
};

module.exports = handler;
