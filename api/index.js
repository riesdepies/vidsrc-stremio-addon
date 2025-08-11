// api/index.js

global.fetch = undefined; // VERBERG DE PROBLEMATISCHE INGEBOUWDE FETCH

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
        const body = chunk ? chunk.toString('utf-8') : '';

        // Stel alleen een lange cachetijd in als de respons succesvol is (status 200)
        // en een ECHTE, afspeelbare stream-URL bevat.
        if (this.statusCode === 200 && body.includes('"url":"http')) {
            // SUCCES: Cache voor 6 uur.
            this.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=3600');
        } else {
            // FOUT, "RETRY"-LINK of LEGE RESPONS: NIET CACHEN.
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
