const { addonBuilder } = require("stremio-addon-sdk");
const { createClient } = require("@vercel/kv");
// Importeer de proxy-logica direct
const { executeProxyFetch } = require('./api/proxy.js');

// Cache levensduur in seconden (4 uur)
const CACHE_TTL_SECONDS = 4 * 60 * 60; 

// --- DYNAMISCHE HOST & ICOON URL ---
// Gebruik de productie-URL van Vercel indien beschikbaar, anders de deployment-URL, anders localhost.
// Dit zorgt voor een stabiele URL voor het icoon.
const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '127.0.0.1:3000';
const iconUrl = `https://${host}/icon.png`;

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

// --- FUNCTIES ---

// Deze functie roept nu direct de geïmporteerde proxy-logica aan
async function fetchViaProxy(url, options) {
    try {
        return await executeProxyFetch(url, options.headers || {});
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error(`[PROXY CALL ERROR] Fout bij aanroepen van proxy-functie voor ${url}:`, error.message);
        }
        throw error;
    }
}

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
                return url;
            }
        }
    }
    return null;
}

function findHtmlIframeSrc(html) {
    const staticRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/;
    const match = html.match(staticRegex);
    return match ? match[1] : null;
}

async function searchDomain(domain, apiType, imdbId, season, episode, controller, visitedUrls) {
    let initialTarget = `https://${domain}/embed/${apiType}/${imdbId}`;
    if (apiType === 'tv' && season && episode) {
        initialTarget += `/${season}-${episode}`;
    }
    
    let currentUrl = initialTarget;
    let previousUrl = null;
    
    for (let step = 1; step <= MAX_REDIRECTS; step++) {
        if (controller.signal.aborted) return null;
        if (visitedUrls.has(currentUrl)) return null;
        visitedUrls.add(currentUrl);
        
        try {
            // De AbortController.signal werkt niet direct op onze custom functie,
            // maar de timeout in de proxy-functie en de check aan het begin van de loop vangen dit op.
            const response = await fetchViaProxy(currentUrl, { 
                headers: { ...COMMON_HEADERS, 'Referer': previousUrl || initialTarget } 
            });
            if (!response.ok) break;
            
            const html = await response.text();
            if (step === 1 && html.includes(UNAVAILABLE_TEXT)) {
                console.log(`[UNAVAILABLE] Media niet beschikbaar op domein ${domain}`);
                controller.abort();
                return null;
            }
            
            const m3u8Url = extractM3u8Url(html);
            if (m3u8Url) {
                console.log(`[SUCCESS] m3u8 gevonden op domein ${domain}`);
                controller.abort();
                return { masterUrl: m3u8Url, sourceDomain: domain };
            }
            
            let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
            } else {
                console.log(`[STUCK] Geen volgende iframe gevonden op ${currentUrl}`);
                break;
            }
        } catch (error) {
            if (error.name !== 'AbortError') console.error(`[ERROR] Fout bij verwerken van domein ${domain} op URL ${currentUrl}:`, error.message);
            break;
        }
    }
    return null;
}

// ... de rest van het bestand (scrapeNewVidSrcStream, getVidSrcStreamWithCache, builder) blijft ongewijzigd ...
// (De ongewijzigde code wordt hier weggelaten voor de beknoptheid, maar u moet het hele bestand gebruiken)

function scrapeNewVidSrcStream(type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    const controller = new AbortController();
    const visitedUrls = new Set();
    const domainQueue = [...VIDSRC_DOMAINS];
    
    for (let i = domainQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [domainQueue[i], domainQueue[j]] = [domainQueue[j], domainQueue[i]];
    }
    
    return new Promise(resolve => {
        let activeSearches = 0;
        let resultFound = false;
        
        const onComplete = () => {
            activeSearches--;
            if (activeSearches === 0 && !resultFound) resolve(null);
        };
        
        const launchNext = () => {
            if (resultFound || domainQueue.length === 0) {
                if (activeSearches === 0 && !resultFound) resolve(null);
                return;
            }
            
            activeSearches++;
            const domain = domainQueue.shift();
            
            searchDomain(domain, apiType, imdbId, season, episode, controller, visitedUrls)
                .then(result => {
                    if (result && !resultFound) {
                        resultFound = true;
                        resolve(result);
                    }
                }).catch(err => {
                    // Errors worden al gelogd in de functies
                }).finally(() => {
                    onComplete();
                    launchNext(); // Start de volgende zoekopdracht zodra er een plek vrij is
                });
        };
        
        // Start maximaal 3 parallelle zoekopdrachten
        for (let i = 0; i < 3; i++) {
            launchNext();
        }
    });
}

async function getVidSrcStreamWithCache(type, imdbId, season, episode) {
    try {
        const kv = createClient({
            url: process.env.KV_REST_API_URL,
            token: process.env.KV_REST_API_TOKEN,
        });
        
        const streamId = `${imdbId}:${season || '0'}:${episode || '0'}`;
        const cacheKey = `stream:${streamId}`;

        const cachedStream = await kv.get(cacheKey);
        if (cachedStream) {
            console.log(`[CACHE HIT] Found in KV cache for ${streamId}`);
            return { ...cachedStream, fromCache: true };
        }

        console.log(`[CACHE MISS] No valid cache for ${streamId}, starting fresh scrape...`);
        const streamSource = await scrapeNewVidSrcStream(type, imdbId, season, episode);

        if (streamSource) {
            console.log(`[SCRAPE SUCCESS] New stream found for ${streamId}. Storing in cache...`);
            await kv.set(cacheKey, streamSource, { ex: CACHE_TTL_SECONDS });
            return { ...streamSource, fromCache: false };
        }
        return null;

    } catch (error) {
        console.error('[FATAL KV ERROR] Caching mechanism failed. Scraping without cache.', error);
        const streamSource = await scrapeNewVidSrcStream(type, imdbId, season, episode);
        return streamSource ? { ...streamSource, fromCache: false } : null;
    }
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) {
        return Promise.resolve({ streams: [] });
    }

    const streamSource = await getVidSrcStreamWithCache(type, imdbId, season, episode);

    if (streamSource && streamSource.masterUrl) {
        const title = streamSource.fromCache 
            ? `${streamSource.sourceDomain} (cached)` 
            : streamSource.sourceDomain;

        const stream = {
            url: streamSource.masterUrl,
            title: title
        };
        return Promise.resolve({ streams: [stream] });
    }

    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();