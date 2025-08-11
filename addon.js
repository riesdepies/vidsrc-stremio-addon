// addon.js
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

// --- DYNAMISCHE HOST & URLS ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;
const proxyUrlBase = host.startsWith('http') ? `${host}/api/proxy?url=` : `https://${host}/api/proxy?url=`;

// --- MANIFEST ---
const manifest = {
    "id": "community.nepflix.ries",
    "version": "1.7.0", // Versie verhoogd voor timeout-logica
    "name": "Nepflix",
    "description": "HLS streams van VidSrc met timeouts en robuuste retries",
    "icon": iconUrl,
    "catalogs": [],
    "resources": ["stream"],
    "types": ["movie", "series"],
    "idPrefixes": ["tt"]
};

// --- CONSTANTEN ---
const VIDSRC_DOMAINS = ["vidsrc.xyz", "vidsrc.in", "vidsrc.io", "vidsrc.me", "vidsrc.net", "vidsrc.pm", "vidsrc.vc", "vidsrc.to", "vidsrc.icu"];
const MAX_REDIRECTS = 5;
const MAX_ATTEMPTS = 5; // Totaal aantal pogingen (1 direct + 4 via proxy)
const FETCH_TIMEOUT_MS = 5000; // Time-out per fetch-poging in milliseconden
const STAGGER_DELAY_MS = 200;
const UNAVAILABLE_TEXT = 'This media is unavailable at the moment.';

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9'
};

// --- NIEUWE FETCH-FUNCTIE MET INGEBOUWDE TIMEOUT EN RETRIES ---
async function fetchWithRetries(url, options) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Maak voor elke poging een nieuwe AbortController voor de time-out.
        const timeoutController = new AbortController();
        const timeout = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);

        // Combineer de time-out-signal met het algemene signaal van de orchestrator.
        // Als een van de twee abort, stopt de fetch.
        const combinedSignal = AbortSignal.any([options.signal, timeoutController.signal]);

        try {
            let response;
            const fetchOptions = { ...options, signal: combinedSignal };
            
            if (attempt === 1) {
                // Poging 1: Direct
                response = await fetch(url, fetchOptions);
            } else {
                // Poging 2-5: Via proxy
                console.log(`[RETRY ${attempt}/${MAX_ATTEMPTS}] Poging via proxy voor ${url}`);
                const proxiedUrl = proxyUrlBase + encodeURIComponent(url);
                response = await fetch(proxiedUrl, { 
                    headers: options.headers, 
                    signal: combinedSignal 
                });
            }

            if (response.ok) {
                clearTimeout(timeout); // Belangrijk: annuleer de time-out bij succes.
                return { response, attempt };
            }
            
            console.log(`[ATTEMPT ${attempt} FAILED] Status ${response.status} voor ${url}`);

        } catch (error) {
            if (error.name === 'AbortError') {
                if (timeoutController.signal.aborted) {
                    console.error(`[ATTEMPT ${attempt} FAILED] Timeout na ${FETCH_TIMEOUT_MS}ms`);
                } else {
                    // Dit betekent dat de algemene zoekopdracht is gestopt (omdat een andere is geslaagd).
                    // Gooi de error door om de lus te stoppen.
                    throw new Error("Operation aborted by orchestrator");
                }
            } else {
                 console.error(`[ATTEMPT ${attempt} FAILED] Error: ${error.message}`);
            }
        } finally {
            clearTimeout(timeout); // Zorg ervoor dat de timeout altijd wordt opgeruimd.
        }
    }
    // Als de lus eindigt zonder succes
    throw new Error(`Alle ${MAX_ATTEMPTS} pogingen voor ${url} zijn mislukt.`);
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
        if (match[1] && !match[1].split('?')[0].endsWith('.js')) return match[1];
    }
    return null;
}

function findHtmlIframeSrc(html) {
    const staticRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/;
    const match = html.match(staticRegex);
    return match ? match[1] : null;
}

// --- searchDomain functie (ONGEWIJZIGD qua logica, gebruikt nu de nieuwe fetcher) ---
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
            const { response, attempt } = await fetchWithRetries(currentUrl, {
                signal,
                headers: { ...COMMON_HEADERS, 'Referer': previousUrl || initialTarget }
            });

            const html = await response.text();
            
            if (step === 1 && html.includes(UNAVAILABLE_TEXT)) {
                controller.abort();
                return null;
            }

            const m3u8Url = extractM3u8Url(html);
            if (m3u8Url) {
                controller.abort();
                return { masterUrl: m3u8Url, sourceDomain: domain, attempt };
            }

            let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
            } else { break; }

        } catch (error) {
            if (error.message !== "Operation aborted by orchestrator") {
                 console.error(`[ERROR] Verwerken van domein ${domain} gestopt:`, error.message);
            }
            break;
        }
    }
    return null;
}

// --- Orchestrator (ONGEWIJZIGD) ---
function getVidSrcStream(type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    const controller = new AbortController();
    const visitedUrls = new Set();
    const MAX_CONCURRENT_SEARCHES = 3;

    const domainQueue = [...VIDSRC_DOMAINS].sort(() => 0.5 - Math.random());
    
    return new Promise(resolve => {
        let activeSearches = 0;
        let resultFound = false;

        const launchNext = () => {
            if (resultFound || domainQueue.length === 0) {
                if (activeSearches === 0 && !resultFound) resolve(null);
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
                    } else if (!resultFound) {
                        launchNext();
                    }
                });
        };

        for (let i = 0; i < MAX_CONCURRENT_SEARCHES; i++) {
            setTimeout(() => {
                if (!resultFound) launchNext();
            }, i * STAGGER_DELAY_MS);
        }
    });
}

function getOrdinalSuffix(n) {
    if (n === 2) return '2nd';
    if (n === 3) return '3rd';
    return `${n}th`;
}

// --- Stream Handler met AANGEPASTE TITEL ---
const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) return Promise.resolve({ streams: [] });

    const streamSource = await getVidSrcStream(type, imdbId, season, episode);

    if (streamSource) {
        // Bouw de titel dynamisch op, zonder blokhaken.
        let title = streamSource.sourceDomain;
        if (streamSource.attempt > 1) {
            const suffix = getOrdinalSuffix(streamSource.attempt);
            title += ` (${suffix} try)`;
        }

        const stream = { url: streamSource.masterUrl, title };
        return Promise.resolve({ streams: [stream] });
    }

    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
