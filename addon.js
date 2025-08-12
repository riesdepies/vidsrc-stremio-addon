// addon.js

const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');
const { createClient } = require("@vercel/kv");

// Cache levensduur in seconden (4 uur)
const CACHE_TTL_SECONDS = 4 * 60 * 60; 

// --- DYNAMISCHE HOST & ICOON URL ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;

// --- MANIFEST ---
const manifest = {
    "id": "community.nepflix.ries",
    "version": "1.5.0", // Versie verhoogd
    "name": "Nepflix",
    "description": "HLS streams van VidSrc",
    "icon": iconUrl,
    "catalogs": [],
    "resources": ["stream"],
    "types": ["movie", "series"],
    "idPrefixes": ["tt"]
};

const VIDSRC_DOMAINS = ["vidsrc.xyz", "vidsrc.in", "vidsrc.io", "vidsrc.me", "vidsrc.net", "vidsrc.pm", "vidsrc.vc", "vidsrc.to", "vidsrc.icu"];
const UNAVAILABLE_TEXT = 'This media is unavailable at the moment.';

// --- FUNCTIES ---

async function fetchStreamFromProxy(type, imdbId, season, episode) {
    const proxyUrl = host.startsWith('http') ? `${host}/api/proxy` : `https://${host}/api/proxy`;
    try {
        const proxyRes = await fetch(proxyUrl, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ 
                type, 
                imdbId, 
                season, 
                episode,
                domains: VIDSRC_DOMAINS // Stuur de domeinen naar de proxy
            }),
        });

        if (!proxyRes.ok) {
            console.error(`[PROXY CLIENT ERROR] Proxy-aanroep mislukt met status: ${proxyRes.status}`);
            return null;
        }

        const data = await proxyRes.json();
        if (data.error) {
            // Log alleen als het een onverwachte fout is, niet als er gewoon geen stream is gevonden.
            if (data.error !== 'Stream not found') {
               console.error(`[PROXY CLIENT ERROR] Fout ontvangen van proxy:`, data.details || data.error);
            }
            return null;
        }
        return data; // Verwacht { masterUrl, sourceDomain }

    } catch (error) {
        console.error(`[PROXY CLIENT ERROR] Fout bij aanroepen van proxy:`, error.message);
        throw error;
    }
}


// --- SCRAPING & CACHING LOGICA ---
async function getVidSrcStreamWithCache(type, imdbId, season, episode) {
    let kv;
    try {
        kv = createClient();
    } catch(e) {
        console.error('[FATAL KV ERROR] Kon geen verbinding maken met Vercel KV. Caching is uitgeschakeld.', e);
        // Val terug op scrapen zonder cache
        const streamSource = await fetchStreamFromProxy(type, imdbId, season, episode);
        return { streamSource, fromCache: false };
    }

    const streamId = `${imdbId}:${season || '0'}:${episode || '0'}`;
    const cacheKey = `stream:${streamId}`;

    try {
        const cachedStream = await kv.get(cacheKey);
        if (cachedStream) {
            console.log(`[CACHE HIT] Found in KV cache for ${streamId}`);
            return { streamSource: cachedStream, fromCache: true };
        }

        console.log(`[CACHE MISS] No valid cache for ${streamId}, starting fresh scrape via proxy...`);
        const streamSource = await fetchStreamFromProxy(type, imdbId, season, episode);

        if (streamSource) {
            console.log(`[SCRAPE SUCCESS] New stream found for ${streamId}. Storing in cache...`);
            await kv.set(cacheKey, streamSource, { ex: CACHE_TTL_SECONDS });
            return { streamSource, fromCache: false };
        }
        
        return { streamSource: null, fromCache: false };

    } catch (error) {
        console.error('[KV/PROXY ERROR] Caching/Scraping-mechanisme mislukt. Probeert te scrapen zonder cache.', error);
        const streamSource = await fetchStreamFromProxy(type, imdbId, season, episode);
        return { streamSource, fromCache: false };
    }
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) {
        return Promise.resolve({ streams: [] });
    }

    // De functie retourneert nu een object met de bron en of het uit de cache komt
    const result = await getVidSrcStreamWithCache(type, imdbId, season, episode);

    if (result && result.streamSource && result.streamSource.masterUrl) {
        const title = result.fromCache
            ? `${result.streamSource.sourceDomain} (cached)`
            : result.streamSource.sourceDomain;
        
        const stream = {
            url: result.streamSource.masterUrl,
            title: title
        };
        return Promise.resolve({ streams: [stream] });
    }

    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();