const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

// --- DYNAMISCHE HOST & ICOON URL ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;

// --- MANIFEST ---
const manifest = {
    "id": "community.nepflix.ries",
    "version": "1.4.0", // Versie verhoogd vanwege significante wijziging
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

// Helper-functie die het zoekproces voor één enkel domein uitvoert. (ONGEWIJZIGD)
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
            const response = await fetch(currentUrl, {
                signal,
                headers: {
                    ...COMMON_HEADERS,
                    'Referer': previousUrl || initialTarget,
                }
            });
            if (!response.ok) break;

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
                console.error(`[ERROR] Fout bij verwerken van domein ${domain} op URL ${currentUrl}:`, error.message);
            }
            break;
        }
    }
    return null;
}

// --- AANGEPASTE ORCHESTRATOR-FUNCTIE ---
// Beheert een "worker pool" van maximaal 3 parallelle zoekopdrachten.
function getVidSrcStream(type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    const controller = new AbortController();
    const visitedUrls = new Set();
    const MAX_CONCURRENT_SEARCHES = 3;

    // Stap 1: Maak een willekeurige wachtrij van domeinen
    const domainQueue = [...VIDSRC_DOMAINS];
    for (let i = domainQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [domainQueue[i], domainQueue[j]] = [domainQueue[j], domainQueue[i]];
    }
    
    // We gebruiken een Promise om het uiteindelijke resultaat af te handelen.
    return new Promise(resolve => {
        let activeSearches = 0;
        let resultFound = false;

        // Functie die een nieuwe zoekopdracht start.
        const launchNext = () => {
            // Stop als resultaat al gevonden is of de wachtrij leeg is.
            if (resultFound || domainQueue.length === 0) {
                // Als er geen actieve zoekopdrachten meer zijn en de wachtrij leeg is,
                // betekent dit dat alles is geprobeerd en niets is gevonden.
                if (activeSearches === 0 && !resultFound) {
                    resolve(null);
                }
                return;
            }

            activeSearches++;
            const domain = domainQueue.shift(); // Pak het volgende domein uit de wachtrij.

            searchDomain(domain, apiType, imdbId, season, episode, controller, visitedUrls)
                .then(result => {
                    activeSearches--;

                    // Als dit de winnende zoekopdracht is, sla het resultaat op.
                    if (result && !resultFound) {
                        resultFound = true;
                        resolve(result); // Dit stopt de hele operatie.
                    } else {
                        // Deze zoekopdracht is klaar, start de volgende uit de wachtrij.
                        launchNext();
                    }
                });
        };

        // Stap 2: Start de initiële workers om de pool te vullen.
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
            title: streamSource.sourceDomain
        };
        return Promise.resolve({ streams: [stream] });
    }

    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
