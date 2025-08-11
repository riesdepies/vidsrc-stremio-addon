// api/index.js

const { getRouter } = require('stremio-addon-sdk');
// Importeer nu het object met de interface en de scrape-functie
const { addonInterface, getVidSrcStream } = require('../addon.js');

const router = getRouter(addonInterface);

// --- NIEUWE ROUTE VOOR HET AFHANDELEN VAN DE ZOEKOPDRACHT ---
// Deze route wordt aangeroepen wanneer de gebruiker op de "Zoek op Nepflix" knop klikt.
router.get('/search/:type/:id', async (req, res) => {
    // Zorg ervoor dat de response als JSON wordt behandeld door Stremio en de cache-logica.
    res.setHeader('Content-Type', 'application/json');

    const { type, id } = req.params;
    const [imdbId, season, episode] = id.split(':');

    if (!imdbId) {
        // Stuur een lege streamlijst terug als de ID ongeldig is.
        return res.end(JSON.stringify({ streams: [] }));
    }

    // NU PAS WORDT HET SCRAPEN GESTART
    const streamSource = await getVidSrcStream(type, imdbId, season, episode);

    let streams = [];
    if (streamSource) {
        streams.push({
            url: streamSource.masterUrl,
            // Geef een duidelijke titel met de gevonden bron
            title: `Nepflix - ${streamSource.sourceDomain}`
        });
    }

    // Stuur de gevonden stream (of een lege lijst) terug.
    // De res.end() wrapper hieronder zal de juiste cache-header toevoegen.
    res.end(JSON.stringify({ streams: streams }));
});

module.exports = (req, res) => {
    // Voeg CORS headers toe
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    // Onderschep de 'end' functie om de cache-header conditioneel in te stellen.
    const originalEnd = res.end;
    res.end = function (chunk, encoding) {
        // 'this' verwijst naar het 'res' object.
        const body = chunk ? chunk.toString('utf-8') : '';

        // Stel alleen een lange cachetijd in als de respons succesvol is (status 200)
        // en een ECHTE, afspeelbare stream-URL bevat.
        // We controleren op '"url":"http' om 'stremio://' urls uit te sluiten.
        if (this.statusCode === 200 && body.includes('"url":"http')) {
            // SUCCES: Cache voor 6 uur.
            this.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=3600');
        } else {
            // FOUT, "ZOEK"-LINK of LEGE RESPONS: NIET CACHEN.
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
