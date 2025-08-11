const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

// --- DYNAMISCHE HOST & ICOON URL ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;

// --- MANIFEST ---
const manifest = {
    "id": "community.nepflix.ries",
    "version": "1.4.0", // Versie verhoogd
    "name": "Nepflix",
    "description": "HLS streams van VidSrc met sequentiële proxy fallback.",
    "icon": iconUrl,
    "catalogs": [],
    "resources": ["stream"],
    "types": ["movie", "series"],
    "idPrefixes": ["tt"]
};

const VIDSRC_DOMAINS = ["vidsrc.xyz", "vidsrc.in", "vidsrc.io", "vidsrc.me", "vidsrc.net", "vidsrc.pm", "vidsrc.vc", "vidsrc.to", "vidsrc.icu"];
const MAX_REDIRECTS = 5;

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    'Accept-Language': 'en-US,en;q=0.9',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'iframe',
};

const PROXIES = [
    { name: 'CORSProxy.io', template: 'https://api.corsproxy.io/', needsEncoding: false, responseType: 'raw' },
    { name: 'Codetabs', template: 'https://api.codetabs.com/v1/proxy?quest=', needsEncoding: true, responseType: 'raw' },
    { name: 'All Origins', template: 'https://api.allorigins.win/raw?url=', needsEncoding: true, responseType: 'json', jsonKey: 'contents' },
    { name: 'corsmirror.com', template: 'https://corsmirror.com/v1?url=', needsEncoding: true, responseType: 'raw' },
    { name: 'Whatever Origin', template: 'https://whateverorigin.org/get?url=', needsEncoding: true, responseType: 'json', jsonKey: 'contents' },
    { name: 'Tuananh Worker', template: 'https://cors-proxy.tuananh.workers.dev/?', needsEncoding: false, responseType: 'raw' },
    { name: 'Novadrone Worker', template: 'https://cors-proxy.novadrone16.workers.dev?url=', needsEncoding: true, responseType: 'raw' },
    { name: 'My CORS Proxy', template: 'https://my-cors-proxy-kappa.vercel.app/api/proxy?url=', needsEncoding: true, responseType: 'raw' },
];

/**
 * AANGEPAST: Probeert proxies nu één voor één (sequentieel) in plaats van tegelijk.
 * Dit is stabieler en geeft betere logging op Vercel.
 */
async function fetchViaCorsProxy(targetUrl, options = {}, timeout = 5000) {
    const constructProxyUrl = (proxy, url) => {
        const urlPart = proxy.needsEncoding ? encodeURIComponent(url) : url;
        return proxy.template + urlPart;
    };

    // Loop door elke proxy, één voor één.
    for (const proxy of PROXIES) {
        try {
            console.log(`[PROXY ATTEMPT] Probeert nu proxy: ${proxy.name}`);
            const proxyUrl = constructProxyUrl(proxy, targetUrl);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const fetchOptions = { ...options, signal: controller.signal };
            const response = await fetch(proxyUrl, fetchOptions);
            
            clearTimeout(timeoutId); // Stop de timer als de fetch slaagt

            if (!response.ok) {
                throw new Error(`Status code ${response.status}`);
            }

            console.log(`[PROXY SUCCESS] Data opgehaald via ${proxy.name}`);
            
            let html;
            if (proxy.responseType === 'json') {
                const data = await response.json();
                html = data[proxy.jsonKey];
                if (!html) throw new Error("Lege 'contents' in JSON-respons.");
            } else {
                html = await response.text();
            }
            
            // Als we hier komen, is het gelukt. Geef de HTML terug en stop de lus.
            return html;

        } catch (error) {
            // Log de specifieke fout voor deze proxy en ga door naar de volgende.
            console.error(`[PROXY FAIL] Proxy '${proxy.name}' faalde: ${error.message}`);
        }
    }

    // Als de lus is afgelopen en geen enkele proxy is geslaagd, gooi dan een finale fout.
    throw new Error("Alle proxies zijn geprobeerd en hebben gefaald.");
}

// De rest van de code blijft ongewijzigd.
async function fetchWithProxyFallback(url, options = {}) {
    try {
        const directResponse = await fetch(url, options);
        if (!directResponse.ok) {
            throw new Error(`Directe fetch mislukt: status ${directResponse.status}`);
        }
        console.log(`[DIRECT SUCCESS] Rechtstreeks opgehaald: ${url}`);
        const html = await directResponse.text();
        return { html: html, usedProxy: false };
    } catch (directError) {
        console.warn(`[DIRECT FAIL] ${directError.message}. Fallback naar proxies voor ${url}`);
        const html = await fetchViaCorsProxy(url, options);
        return { html: html, usedProxy: true };
    }
}

function extractM3u8Url(htmlContent) { const regex = /(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/; const match = htmlContent.match(regex); return match ? match[1] : null; }
function findJsIframeSrc(html) { const combinedRegex = /(?:src:\s*|\.src\s*=\s*)["']([^"']+)["']/g; let match; while ((match = combinedRegex.exec(html)) !== null) { const url = match[1]; if (url) { const path = url.split('?')[0].split('#')[0]; if (!path.endsWith('.js')) return url; } } return null; }
function findHtmlIframeSrc(html) { const staticRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/; const match = html.match(staticRegex); return match ? match[1] : null; }

async function getVidSrcStream(type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    for (const domain of VIDSRC_DOMAINS) {
        let proxyWasUsedInChain = false;
        try {
            let initialTarget = `https://${domain}/embed/${apiType}/${imdbId}`;
            if (type === 'series' && season && episode) { initialTarget += `/${season}-${episode}`; }
            let currentUrl = initialTarget;
            let previousUrl = null;

            for (let step = 1; step <= MAX_REDIRECTS; step++) {
                console.log(`[STEP ${step}] Fetching from ${currentUrl} (Domain: ${domain})`);
                
                const { html, usedProxy } = await fetchWithProxyFallback(currentUrl, {
                    headers: { ...COMMON_HEADERS, 'Referer': previousUrl || initialTarget }
                });
                
                if (usedProxy) { proxyWasUsedInChain = true; }
                const m3u8Url = extractM3u8Url(html);

                if (m3u8Url) {
                    console.log(`[M3U8 FOUND] Stream gevonden op ${domain}`);
                    return { masterUrl: m3u8Url, sourceDomain: domain, wasProxied: proxyWasUsedInChain };
                }

                let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
                if (nextIframeSrc) {
                    previousUrl = currentUrl;
                    currentUrl = new URL(nextIframeSrc, currentUrl).href;
                } else {
                    console.log(`[END OF CHAIN] Geen iframes meer op ${domain}`);
                    break;
                }
            }
        } catch (error) {
            console.error(`[DOMAIN FAILED] Fout bij verwerken van domein ${domain}:`, error.message);
        }
    }
    console.log(`[NOT FOUND] Geen stream gevonden voor ${imdbId}`);
    return null;
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) return Promise.resolve({ streams: [] });
    
    console.log(`Verzoek voor stream: ${type}: ${id}`);
    const streamSource = await getVidSrcStream(type, imdbId, season, episode);

    if (streamSource) {
        let streamTitle = `Nepflix - ${streamSource.sourceDomain}`;
        if (streamSource.wasProxied) { streamTitle += ' (via Proxy)'; }
        const stream = { url: streamSource.masterUrl, title: streamTitle };
        return Promise.resolve({ streams: [stream] });
    }

    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
