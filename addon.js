// addon.js
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

// --- DYNAMISCHE HOST & URLS ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;
const proxyUrl = host.startsWith('http') ? `${host}/api/proxy?url=` : `https://${host}/api/proxy?url=`;

// --- MANIFEST ---
const manifest = {
    "id": "community.nepflix.ries",
    "version": "1.5.0", // Versie verhoogd vanwege fallback proxy
    "name": "Nepflix",
    "description": "HLS streams van VidSrc met proxy fallback",
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

// --- NIEUWE HELPER-FUNCTIE: Fetch met proxy fallback ---
async function fetchWithFallback(url, options) {
    try {
        // Poging 1: Directe fetch
        const directResponse = await fetch(url, options);
        if (directResponse.ok) {
            return directResponse;
        }
        console.log(`[FALLBACK] Directe fetch naar ${url} mislukt met status ${directResponse.status}. Probeert proxy...`);
    } catch (error) {
        console.log(`[FALLBACK] Directe fetch naar ${url} gooide een fout: ${error.message}. Probeert proxy...`);
    }

    // Poging 2: Fetch via de proxy
    // De headers worden meegestuurd naar de proxy, die ze vervolgens doorstuurt.
    const proxiedUrl = proxyUrl + encodeURIComponent(url);
    try {
         const proxyResponse = await fetch(proxiedUrl, options);
         if (!proxyResponse.ok) {
            throw new Error(`Proxy reageerde met status ${proxyResponse.status}`);
         }
         return proxyResponse;
    } catch(proxyError) {
        console.error(`[PROXY FETCH FAILED] Ook de proxy-fetch naar ${url} is mislukt: ${proxyError.message}`);
        // Gooi de fout door zodat de zoekopdracht voor dit domein stopt.
        throw proxyError;
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

// --- AANGEPASTE `searchDomain` FUNCTIE ---
// Gebruikt nu de `fetchWithFallback` helper.
async function searchDomain(domain, apiType, imdbId, season, episode, controller, visitedUrls) {
    const signal = controller.signal;
    let initialTarget = `https://${domain}/embed/${apiType}/${imdbId}`;
    if (apiType === 'tv' && season && episode) {
        initialTarget += `/${season}-${episode}`;
    }

    let currentUrl = initialTarget;
    let previousUrl = null;

    for (let step = 1; step <= MAX_REDIRECTS; step++) {
        if (signal.aborted) return null;
        if (visitedUrls.has(currentUrl)) return null;
        visitedUrls.add(currentUrl);

        try {
            // Gebruik de nieuwe fetch-functie met ingebouwde fallback.
            const response = await fetchWithFallback(currentUrl, {
                signal,
                headers: {
                    ...COMMON_HEADERS,
                    'Referer': previousUrl || initialTarget,
                }
            });
            // De fallback gooit een error als hij ook mislukt, dus we hoeven niet opnieuw 'ok' te checken.

            const html = await response.text();
            
            if (step === 1 && html.includes(UNAVAILABLE_TEXT)) {
                controller.abort();
                return null;
            }

            const m3u8Url = extractM3u8Url(html);
            if (m3u8Url) {
                controller.abort();
                return { masterUrl: m3u8Url, sourceDomain: domain };
            }

            let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
            } else {
                break;
            }

        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error(`[ERROR] Fout bij verwerken van domein ${domain} op URL ${currentUrl} (ook na fallback):`, error.message);
            }
            break;
        }
    }
    return null;
}

// --- ONGEWIJZIGDE ORCHESTRATOR-FUNCTIE ---
function getVidSrcStream(type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    const controller = new AbortController();
    const visitedUrls = new Set();
    const MAX_CONCURRENT_SEARCHES = 3;

    const domainQueue = [...VIDSRC_DOMAINS];
    for (let i = domainQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [domainQueue[i], domainQueue[j]] = [domainQueue[j], domainQueue[i]];
    }
    
    return new Promise(resolve => {
        let activeSearches = 0;
        let resultFound = false;

        const launchNext = () => {
            if (resultFound || domainQueue.length === 0) {
                if (activeSearches === 0 && !resultFound) {
                    resolve(null);
                }
                return;
            }

            activeSearches++;
            const domain = domainQueue.shift(); 

            searchDomain(domain, apiType, imdbId, season, episode, controller, visitedUrls)
                .then(result => {
                    activeSearches--;

                    if (result && !resultFound) {
                        resultFound = true;
                        resolve(result);
                    } else {
                        launchNext();
                    }
                });
        };

        for (let i = 0; i < MAX_CONCURRENT_SEARCHES; i++) {
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

    const streamSource = await getVidSrcStream(type, imdbId, season, episode);

    if (streamSource) {
        const stream = {
            url: streamSource.masterUrl,
            title: `[Fallback] ${streamSource.sourceDomain}`
        };
        return Promise.resolve({ streams: [stream] });
    }

    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
