const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

// --- CONFIGURATIE ---
// Lijst van domeinen die geprobeerd worden, op volgorde. vidsrc.xyz eerst.
const VIDSRC_DOMAINS = [
    "vidsrc.xyz",
    "vidsrc.in",
    "vidsrc.io",
    "vidsrc.me",
    "vidsrc.net",
    "vidsrc.pm",
    "vidsrc.vc",
    "vidsrc.to",
    "vidsrc.icu",
];
const MAX_REDIRECTS = 10; // Maximale stappen per domein om een oneindige lus te voorkomen.

// --- MANIFEST ---
// Beschrijft de addon voor Stremio
const manifest = {
    "id": "community.vidsrc.ries",
    "version": "1.0.0",
    "catalogs": [],
    "resources": ["stream"],
    "types": ["movie", "series"],
    "name": "VidSrc Scraper",
    "description": "Haalt streamingbronnen op van VidSrc en vergelijkbare domeinen.",
    "idPrefixes": ["tt"]
};

// --- HELPER FUNCTIES (vertaald uit uw HTML) ---
// Deze functies zijn direct overgenomen uit de logica van uw script.

function extractM3u8Url(htmlContent) {
    const regex = /(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/;
    const match = htmlContent.match(regex);
    return match ? match[1] : null;
}

function findJsIframeSrc(html) {
    const combinedRegex = /(?:src:\s*|\.src\s*=\s*)["']([^"']+)["']/g;
    let match;
    while ((match = combinedRegex.exec(html)) !== null) {
        const url = match[1];
        if (url) {
            const path = url.split('?')[0].split('#')[0];
            if (!path.endsWith('.js')) {
                return url; // Gevonden, retourneer direct
            }
        }
    }
    return null; // Niets gevonden
}

function findHtmlIframeSrc(html) {
    const staticRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/;
    const match = html.match(staticRegex);
    return match ? match[1] : null;
}

// --- HOOFDLOGICA ---

/**
 * Probeert een M3U8 stream URL te vinden door een keten van iframes te volgen.
 * @param {string} type - 'movie' of 'series'
 * @param {string} imdbId - De IMDb ID (bv. 'tt0123456')
 * @param {string} [season] - Seizoensnummer voor series
 * @param {string} [episode] - Afleveringsnummer voor series
 * @returns {Promise<string|null>} De M3U8 URL of null als deze niet gevonden is.
 */
async function getVidSrcStream(type, imdbId, season, episode) {
    // Loop door alle beschikbare domeinen totdat een werkende stream is gevonden
    for (const domain of VIDSRC_DOMAINS) {
        console.log(`[INFO] Proberen van domein: ${domain}`);
        try {
            let initialTarget = `https://${domain}/embed/${type}/${imdbId}`;
            if (type === 'series' && season && episode) {
                initialTarget += `/${season}/${episode}`; // Nieuwe URL-structuur is vaak /type/imdb/season/episode
            }

            let currentUrl = initialTarget;
            let previousUrl = null;

            for (let step = 1; step <= MAX_REDIRECTS; step++) {
                console.log(`[${domain} - Stap ${step}] Ophalen van: ${currentUrl}`);

                const response = await fetch(currentUrl, {
                    headers: { 'Referer': previousUrl || initialTarget }
                });

                if (!response.ok) {
                    throw new Error(`HTTP status ${response.status} voor ${currentUrl}`);
                }

                const html = await response.text();

                // 1. Zoek naar de M3U8 URL (hoogste prioriteit)
                const m3u8Url = extractM3u8Url(html);
                if (m3u8Url) {
                    console.log(`[SUCCESS] M3U8 GEVONDEN op ${domain}: ${m3u8Url}`);
                    return m3u8Url; // Succes!
                }

                // 2. Zoek naar de volgende iframe URL
                let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
                if (nextIframeSrc) {
                    // Maak een absolute URL van de gevonden src
                    const nextUrl = new URL(nextIframeSrc, currentUrl).href;
                    console.log(`[INFO] Volgende iframe gevonden: ${nextUrl}`);
                    previousUrl = currentUrl;
                    currentUrl = nextUrl;
                } else {
                    console.log(`[INFO] Geen M3U8 of volgende iframe gevonden op ${domain}. Stoppen met dit domein.`);
                    break; // Stop deze loop en ga naar het volgende domein
                }
            }
        } catch (error) {
            console.error(`[ERROR] Fout bij verwerken van domein ${domain}:`, error.message);
            // Ga door naar het volgende domein in de lijst
        }
    }

    console.log('[FAIL] Geen M3U8 stream gevonden na het proberen van alle domeinen.');
    return null; // Geen stream gevonden
}


// --- ADDON SETUP ---
const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`[REQUEST] Stream verzoek voor: type=${type}, id=${id}`);

    // Parse de ID. Voor series is het formaat "tt1234567:1:1"
    const [imdbId, season, episode] = id.split(':');

    if (!imdbId) {
        return Promise.resolve({ streams: [] });
    }

    // Roep de scraping logica aan
    const streamUrl = await getVidSrcStream(type, imdbId, season, episode);

    if (streamUrl) {
        // Stream gevonden, retourneer deze aan Stremio
        const stream = {
            url: streamUrl,
            title: "VidSrc Stream" // Deze naam zie je in de Stremio speler
        };
        return Promise.resolve({ streams: [stream] });
    } else {
        // Geen stream gevonden
        return Promise.resolve({ streams: [] });
    }
});

// Exporteer de handler die Vercel kan uitvoeren
module.exports = serveHTTP(builder.getInterface());