// addon.js

const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');
const { createClient } = require("@vercel/kv");

// --- INITIALISATIE IS HIER WEGGEHAALD ---

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

// --- AANGEPASTE PROXY FETCH FUNCTIE ---
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

// --- HELPER FUNCTIES ---
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
    const signal = controller.signal;
    let initialTarget = `https://${domain}/embed/${apiType}/${imdbId}`;
    if (apiType === 'tv' && season && episode) {
        initialTarget += `/${season}-${episode}`;
    }

    let currentUrl = initialTarget;
    let previousUrl = null;
    
    console.log(`[SEARCH] Start search on domain: ${domain} for ${imdbId}`);

    for (let step = 1; step <= MAX_REDIRECTS; step++) {
        if (signal.aborted) {
            console.log(`[SEARCH] Search on ${domain} aborted by controller.`);
            return null;
        }
        if (visitedUrls.has(currentUrl)) {
            console.log(`[SEARCH] URL already visited, skipping: ${currentUrl}`);
            return null;
        }
        visitedUrls.add(currentUrl);

        try {
            const response = await fetchViaProxy(currentUrl, {
                signal,
                headers: {
                    ...COMMON_HEADERS,
                    'Referer': previousUrl || initialTarget,
                }
            });
            if (!response.ok) {
                console.log(`[SEARCH] Step ${step} on ${domain}: Received non-OK status ${response.status} for ${currentUrl}`);
                break;
            }

            const html = await response.text();

            if (step === 1 && html.includes(UNAVAILABLE_TEXT)) {
                console.log(`[SEARCH] Media unavailable on domain ${domain}. Aborting all searches.`);
                controller.abort();
                return null;
            }

            const m3u8Url = extractM3u8Url(html);
            if (m3u8Url) {
                console.log(`[SUCCESS] Found m3u8 URL on domain ${domain}: ${m3u8Url}`);
                controller.abort();
                return { masterUrl: m3u8Url, sourceDomain: domain };
            }

            let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
                console.log(`[SEARCH] Step ${step} on ${domain}: Found next iframe, redirecting to: ${currentUrl}`);
            } else {
                console.log(`[SEARCH] Step ${step} on ${domain}: No m3u8 or next iframe found. Ending search for this domain.`);
                break;
            }

        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error(`[ERROR] Fout bij verwerken van domein ${domain} op URL ${currentUrl}:`, error.message);
            }
            break;
        }
    }
    console.log(`[SEARCH] Finished search on domain ${domain} without finding m3u8.`);
    return null;
}

// --- SCRAPING & CACHING LOGICA ---

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
    
    console.log(`[GETSTREAM] Starting fresh stream search for ${imdbId}`);

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

async function getVidSrcStreamWithCache(type, imdbId, season, episode) {
    // AANGEPAST: Initialiseer de client HIER, binnen de async functie.
    const kv = createClient({
        url: process.env.REDIS_URL,
    });
    
    const streamId = `${imdbId}:${season || '0'}:${episode || '0'}`;
    const cacheKey = `stream:${streamId}`;

    // 1. Controleer de KV cache
    try {
        const cachedStream = await kv.get(cacheKey);
        if (cachedStream) {
            console.log(`[CACHE HIT] Found in KV cache for ${streamId}`);
            return cachedStream;
        }
    } catch (err) {
        console.error(`[KV ERROR] Failed to read from cache:`, err);
    }

    console.log(`[CACHE MISS] No valid cache for ${streamId}, starting fresh scrape...`);
    
    // 2. Cache miss: start het scraping proces
    const streamSource = await scrapeNewVidSrcStream(type, imdbId, season, episode);

    // 3. Als scraping succesvol is, sla op in cache
    if (streamSource) {
        console.log(`[SCRAPE SUCCESS] New stream found for ${streamId}. Storing in cache...`);
        try {
            await kv.set(cacheKey, streamSource, { ex: CACHE_TTL_SECONDS });
        } catch (err)
 {
            console.error(`[KV ERROR] Failed to write to cache:`, err);
        }
    }

    return streamSource;
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) {
        return Promise.resolve({ streams: [] });
    }

    const streamSource = await getVidSrcStreamWithCache(type, imdbId, season, episode);

    if (streamSource && streamSource.masterUrl) {
        const stream = {
            url: streamSource.masterUrl,
            title: `[VidSrc] ${streamSource.sourceDomain}`
        };
        return Promise.resolve({ streams: [stream] });
    }

    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();