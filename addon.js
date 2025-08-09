const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

// --- DYNAMISCHE HOST & ICOON URL ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;

// --- MANIFEST ---
const manifest = {
    "id": "community.nepflix.ries",
    "version": "1.1.0",
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
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

// --- PROXY LIJST (gebaseerd op uw voorbeeld) ---
const PROXIES = [
    { name: 'All Origins', template: 'https://api.allorigins.win/raw?url=', needsEncoding: true },
    { name: 'CORSProxy.io', template: 'https://api.corsproxy.io/?', needsEncoding: false },
    { name: 'Codetabs', template: 'https://api.codetabs.com/v1/proxy?quest=', needsEncoding: true },
];

// *** NIEUWE FUNCTIE: Slimme fetch met proxy als fallback ***
async function fetchWithProxies(targetUrl, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 seconden timeout voor directe poging

    // 1. Probeer eerst een directe fetch
    try {
        const response = await fetch(targetUrl, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.ok) {
            return response; // Directe fetch was succesvol
        }
        // Als de status niet ok is (bv. 403, 429), val door naar proxies.
        console.log(`Direct fetch failed with status ${response.status}. Trying proxies...`);
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            console.log('Direct fetch timed out. Trying proxies...');
        } else {
            console.log(`Direct fetch failed: ${error.message}. Trying proxies...`);
        }
    }

    // 2. Als directe fetch faalt, probeer alle proxies parallel
    const constructProxyUrl = (proxy, url) => {
        const urlPart = proxy.needsEncoding ? encodeURIComponent(url) : url;
        return proxy.template + urlPart;
    };
    
    const fetchPromises = PROXIES.map(proxy => {
        const proxyUrl = constructProxyUrl(proxy, targetUrl);
        return fetch(proxyUrl, options);
    });

    try {
        const firstSuccessfulResponse = await Promise.any(fetchPromises);
        return firstSuccessfulResponse;
    } catch (error) {
        throw new Error(`All proxies failed for ${targetUrl}`);
    }
}


function extractM3u8Url(htmlContent) { /* ... ongewijzigd ... */ return (htmlContent.match(/(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/) || [])[1] || null; }
function findJsIframeSrc(html) { /* ... ongewijzigd ... */ const m = html.match(/(?:src:\s*|\.src\s*=\s*)["']((?!.*\.js)[^"']+)["']/); return m ? m[1] : null; }
function findHtmlIframeSrc(html) { /* ... ongewijzigd ... */ const m = html.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/); return m ? m[1] : null; }

function getStreamFromDomain(domain, type, imdbId, season, episode) {
    return new Promise(async (resolve, reject) => {
        try {
            const apiType = type === 'series' ? 'tv' : 'movie';
            let initialTarget = `https://${domain}/embed/${apiType}/${imdbId}`;
            if (type === 'series' && season && episode) {
                initialTarget += `/${season}-${episode}`;
            }
            let currentUrl = initialTarget;
            let previousUrl = null;
            for (let step = 1; step <= MAX_REDIRECTS; step++) {
                // *** GEBRUIK DE NIEUWE FETCH FUNCTIE ***
                const response = await fetchWithProxies(currentUrl, {
                    headers: { 'Referer': previousUrl || initialTarget, 'User-Agent': FAKE_USER_AGENT }
                });

                if (!response.ok) return reject(new Error(`Status ${response.status} op ${domain}`));
                
                const html = await response.text();
                const m3u8Url = extractM3u8Url(html);

                if (m3u8Url) {
                    return resolve({
                        url: m3u8Url,
                        title: `${domain} (adaptive)`
                    });
                }
                const nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
                if (nextIframeSrc) {
                    previousUrl = currentUrl;
                    currentUrl = new URL(nextIframeSrc, currentUrl).href;
                } else {
                    break;
                }
            }
            reject(new Error(`Geen m3u8 gevonden op ${domain}`));
        } catch (error) {
            reject(error);
        }
    });
}

async function findFirstAvailableStream(type, imdbId, season, episode) {
    const promises = VIDSRC_DOMAINS.map(domain =>
        getStreamFromDomain(domain, type, imdbId, season, episode)
    );
    try {
        return await Promise.any(promises);
    } catch (error) {
        console.log("Alle domeinen hebben gefaald.");
        return null;
    }
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) {
        return Promise.resolve({ streams: [] });
    }
    const stream = await findFirstAvailableStream(type, imdbId, season, episode);
    if (stream) {
        return Promise.resolve({ streams: [stream] });
    }
    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
