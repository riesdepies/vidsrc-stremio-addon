const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('../addon.js');

const router = getRouter(addonInterface);

module.exports = (req, res) => {
    // Voeg CORS headers toe
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    // Voeg Caching header toe.
    // s-maxage=21600: Cache 6 uur op de CDN (Vercel Edge).
    // stale-while-revalidate=3600: Serveer oude cache voor 1 uur terwijl op de achtergrond een nieuwe wordt gehaald.
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=3600');

    // Stuur alle requests door naar de addon router
    router(req, res, () => {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ err: 'Not Found' }));
    });
};
