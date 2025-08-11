// api/index.js

global.fetch = undefined; // EERSTE VERDEDIGINGSLINIE

const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('../addon.js');

const router = getRouter(addonInterface);

module.exports = (req, res) => {
    // Voeg CORS headers toe
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    const originalEnd = res.end;
    res.end = function(chunk, encoding) {
        const body = chunk ? chunk.toString('utf-8') : '';
        if (this.statusCode === 200 && body.includes('"url":"http')) {
            this.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=3600');
        } else {
            this.setHeader('Cache-Control', 'public, s-maxage=0');
        }
        originalEnd.call(this, chunk, encoding);
    };

    router(req, res, () => {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ err: 'Not Found' }));
    });
};
