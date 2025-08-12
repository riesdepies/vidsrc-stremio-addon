// addon.js

const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');
const { createClient } = require("@vercel/kv");

// --- INITIALISEER VERCELL KV CLIENT ---
// Vercel vult de environment variabelen automatisch in na het koppelen van de database.
const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Cache levensduur in seconden (4 uur)
const CACHE_TTL_SECONDS = 4 * 60 * 60; 

// --- DYNAMISCHE HOST & ICOON URL ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;

// --- MANIFEST ---
const manifest = {
    "id": "community.nepflix.ries",
    "version": "1.4.0",
    "name": "Nepflix",
    "description": "HLS streams van VidSrc",
    "icon": iconUrl,
    "catalogs": [],
    "resources": ["stream"],
    "types": ["movie", "series"],
    "idPrefixes": ["tt"]
};

const VIDSRC_DOMAINS = ["vidsrc.xyz", "vidsrc.in", "vidsrc.io", "vidsrc.me", "vidsrc.net", "vidsrc.pm", "vidsrc.vc", "vidsrc.to", "vidsrc.icu"];
const MAX_REDIRECTS = 5;
const UNAVAILABLE_TEXT = 'This media is unavailable at the moment.';

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'iframe',
};

// --- AANGEPASTE PROXY FETCH FUNCTIE (ongewijzigd) ---
async function fetchViaProxy(url, options) {
    const proxyUrl = host.startsWith('http')
        ? `${host}/api/proxy`
        : `https://${host}/api/proxy`;

    try {
        const proxyRes = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                targetUrl: url,
                headers: options.headers || {}
            }),
            signal: options.signal
        });

        if (!proxyRes.ok) {
            throw new Error(`Proxy-aanroep mislukt met status: ${proxyRes.status}`);
        }
        const data = await proxyRes.json();
        if (data.error) {
            throw new Error(data.details || data.error);
        }
        return {
            ok: data.status >= 200 && data.status < 300,
            status: data.status,
            statusText: data.statusText,
            text: () => Promise.resolve(data.body)
        };
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error(`[PROXY CLIENT ERROR] Fout bij aanroepen van proxy voor ${url}:`, error.message);
        }
        throw error;
    }
}

// --- HELPER FUNCTIES (ongewijzigd) ---
function extractM3u8Url(htmlContent) { /* ... implementatie ... */ }
function findJsIframeSrc(html) { /* ... implementatie ... */ }
function findHtmlIframeSrc(html) { /* ... implementatie ... */ }
async function searchDomain(domain, apiType, imdbId, season, episode, controller, visitedUrls) { /* ... implementatie ... */ }

// --- SCRAPING & CACHING LOGICA ---
async function getVidSrcStreamWithCache(type, imdbId, season, episode) {
    const streamId = `${imdbId}:${season || '0'}:${episode || '0'}`;
    const cacheKey = `stream:${streamId}`;

    // 1. Controleer de KV cache
    try {
        const cachedStream = await kv.get(cacheKey);
        if (cachedStream) {
            console.log(`[CACHE HIT] Gevonden in KV cache voor ${streamId}`);
            return cachedStream;
        }
    } catch (err) {
        console.error(`[KV ERROR] Fout bij lezen uit cache:`, err);
    }

    console.log(`[CACHE MISS] Geen geldige cache gevonden voor ${streamId}, start scraping...`);
    
    // 2. Cache miss: start het scraping proces
    const streamSource = await scrapeNewVidSrcStream(type, imdbId, season, episode);

    // 3. Als scraping succesvol is, sla op in cache
    if (streamSource) {
        console.log(`[SCRAPE SUCCESS] Nieuwe stream gevonden voor ${streamId}. Opslaan in cache...`);
        try {
            await kv.set(cacheKey, streamSource, { ex: CACHE_TTL_SECONDS });
        } catch (err) {
            console.error(`[KV ERROR] Fout bij schrijven naar cache:`, err);
        }
    }

    return streamSource;
}

function scrapeNewVidSrcStream(type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    const controller = new AbortController();
    const visitedUrls = new Set();
    const MAX_CONCURRENT_SEARCHES = 3;

    const domainQueue = [...VIDSRC_DOMAINS];
    for (let i = domainQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [domainQueue[i], domainQueue[j]] = [domainQueue[j], domainQueue[i]];
    }
    
    console.log(`[GETSTREAM] Starting stream search for ${imdbId}`);

    return new Promise(resolve => {
        let activeSearches = 0;
        let resultFound = false;

        const onComplete = () => {
            activeSearches--;
            if (activeSearches === 0 && !resultFound) {
                console.log(`[GETSTREAM] All searches completed for ${imdbId}, no stream found.`);
                resolve(null);
            }
        };

        const launchNext = () => {
            if (resultFound || domainQueue.length === 0) {
                 if(activeSearches === 0 && !resultFound){
                    console.log(`[GETSTREAM] All searches completed for ${imdbId}, no stream found.`);
                    resolve(null);
                }
                return;
            }

            activeSearches++;
            const domain = domainQueue.shift();

            searchDomain(domain, apiType, imdbId, season, episode, controller, visitedUrls)
                .then(result => {
                    if (result && !resultFound) {
                        resultFound = true;
                        console.log(`[GETSTREAM] Final result found for ${imdbId} from domain ${domain}.`);
                        resolve(result);
                    }
                    onComplete();
                })
                .catch(err => {
                    console.error(`[GETSTREAM] Unhandled error in searchDomain for ${domain}:`, err);
                    onComplete();
                });
        };
        for (let i = 0; i < MAX_CONCURRENT_SEARCHES && i < domainQueue.length; i++) {
            launchNext();
        }
    });
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) {
        return Promise.resolve({ streams: [] });
    }

    const streamSource = await getVidSrcStreamWithCache(type, imdbId, season, episode);

    if (streamSource) {
        const stream = {
            url: streamSource.masterUrl,
            title: `[VidSrc] ${streamSource.sourceDomain}`
        };
        return Promise.resolve({ streams: [stream] });
    }

    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();