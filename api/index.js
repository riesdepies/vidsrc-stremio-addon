// api/index.js

const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('../addon.js');

const router = getRouter(addonInterface);

module.exports = (req, res) => {
    // Voeg CORS headers toe
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    // Onderschep de 'end' functie om de cache-header conditioneel in te stellen.
    const originalEnd = res.end;
    res.end = function(chunk, encoding) {
        // 'this' verwijst naar het 'res' object.
        // We controleren de inhoud van de respons voordat deze wordt verzonden.
        const body = chunk ? chunk.toString('utf-8') : '';

        // Stel alleen een lange cachetijd in als de respons succesvol is (status 200)
        // en daadwerkelijk een stream-URL bevat.
        if (this.statusCode === 200 && body.includes('"url":')) {
            // SUCCES: Cache voor 6 uur.
            this.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=3600');
        } else {
            // FOUT of LEGE RESPONS: NIET CACHEN.
            // s-maxage=0 geeft de Vercel CDN de instructie om deze respons niet op te slaan.
            this.setHeader('Cache-Control', 'public, s-maxage=0');
        }

        // Roep de originele 'end' functie aan om de respons daadwerkelijk te versturen.
        originalEnd.call(this, chunk, encoding);
    };

    // Stuur alle requests door naar de addon router
    router(req, res, () => {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ err: 'Not Found' }));
    });
};
