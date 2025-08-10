const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

// --- DYNAMISCHE HOST & ICOON URL ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;

// --- MANIFEST ---
const manifest = {
    "id": "community.nepflix.ries",
    "version": "1.2.2", // Versie verhoogd
    "name": "Nepflix",
    "description": "HLS streams van VidSrc met uitgebreide proxy fallback.",
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
    { name: 'All Origins', template: 'https://api.allorigins.win/raw?url=', needsEncoding: true },
    { name: 'CORSProxy.io', template: 'https://api.corsproxy.io/', needsEncoding: false },
    { name: 'Codetabs', template: 'https://api.codetabs.com/v1/proxy?quest=', needsEncoding: true },
    { name: 'corsmirror.com', template: 'https://corsmirror.com/v1?url=', needsEncoding: true },
    { name: 'Whatever Origin', template: 'https://whateverorigin.org/get?url=', needsEncoding: true },
    { name: 'Tuananh Worker', template: 'https://cors-proxy.tuananh.workers.dev/?', needsEncoding: false },
    { name: 'Novadrone Worker', template: 'https://cors-proxy.novadrone16.workers.dev?url=', needsEncoding: true },
    { name: 'My CORS Proxy', template: 'https://my-cors-proxy-kappa.vercel.app/api/proxy?url=', needsEncoding: true }
];

async function fetchViaCorsProxy(targetUrl, options = {}) {
    const constructProxyUrl = (proxy, url) => {
        const urlPart = proxy.needsEncoding ? encodeURIComponent(url) : url;
        return proxy.template + urlPart;
    };

    const fetchPromises = PROXIES.map(proxy => {
        const proxyUrl = constructProxyUrl(proxy, targetUrl);
        return new Promise((resolve, reject) => {
            fetch(proxyUrl, options)
                .then(response => {
                    if (response.ok) {
                        console.log(`[PROXY SUCCESS] Fetched via ${proxy.name}`);
                        resolve(response);
                    } else {
                        reject(new Error(`Proxy '${proxy.name}' failed with status: ${response.status}`));
                    }
                })
                .catch(error => {
                    reject(new Error(`Proxy '${proxy.name}' caused a network error: ${error.message}`));
                });
        });
    });

    try {
        return await Promise.any(fetchPromises);
    } catch (error) {
        const allErrors = error.errors ? error.errors.map(e => e.message).join('; ') : 'Unknown error';
        throw new Error(`All CORS proxies failed. Errors: ${allErrors}`);
    }
}

/**
 * AANGEPAST: Geeft nu een object terug met de response en of een proxy is gebruikt.
 * @returns {Promise<{response: Response, usedProxy: boolean}>}
 */
async function fetchWithProxyFallback(url, options = {}) {
    try {
        const directResponse = await fetch(url, options);
        if (!directResponse.ok) {
            throw new Error(`Direct fetch failed with status: ${directResponse.status}`);
        }
        console.log(`[DIRECT SUCCESS] Fetched directly: ${url}`);
        return { response: directResponse, usedProxy: false };
    } catch (directError) {
        console.warn(`[DIRECT FAIL] ${directError.message}. Falling back to proxies for ${url}`);
        const proxyResponse = await fetchViaCorsProxy(url, options);
        return { response: proxyResponse, usedProxy: true };
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
            if (!path.endsWith('.js')) return url;
        }
    }
    return null;
}

function findHtmlIframeSrc(html) {
    const staticRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/;
    const match = html.match(staticRegex);
    return match ? match[1] : null;
}

// --- HOOFDLOGICA ---

/**
 * AANGEPAST: Geeft nu ook terug of een proxy is gebruikt in de keten.
 */
async function getVidSrcStream(type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    for (const domain of VIDSRC_DOMAINS) {
        let proxyWasUsedInChain = false; // Vlag om proxygebruik bij te houden per domein
        try {
            let initialTarget = `https://${domain}/embed/${apiType}/${imdbId}`;
            if (type === 'series' && season && episode) {
                initialTarget += `/${season}-${episode}`;
            }
            let currentUrl = initialTarget;
            let previousUrl = null;

            for (let step = 1; step <= MAX_REDIRECTS; step++) {
                console.log(`[STEP ${step}] Fetching from ${currentUrl} (Domain: ${domain})`);
                
                const { response, usedProxy } = await fetchWithProxyFallback(currentUrl, {
                    headers: { ...COMMON_HEADERS, 'Referer': previousUrl || initialTarget, }
                });
                
                if (usedProxy) {
                    proxyWasUsedInChain = true; // Zet de vlag als een proxy ooit is gebruikt
                }

                const html = await response.text();
                const m3u8Url = extractM3u8Url(html);

                if (m3u8Url) {
                    console.log(`[M3U8 FOUND] Found stream on ${domain}`);
                    return { masterUrl: m3u8Url, sourceDomain: domain, wasProxied: proxyWasUsedInChain };
                }

                let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
                if (nextIframeSrc) {
                    previousUrl = currentUrl;
                    currentUrl = new URL(nextIframeSrc, currentUrl).href;
                } else {
                    console.log(`[END OF CHAIN] No more iframes found on ${domain}`);
                    break;
                }
            }
        } catch (error) {
            console.error(`[DOMAIN FAILED] Error processing domain ${domain}:`, error.message);
        }
    }
    console.log(`[NOT FOUND] No stream found for ${imdbId} on any domain.`);
    return null;
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) {
        return Promise.resolve({ streams: [] });
    }
    console.log(`Requesting stream for ${type}: ${id}`);

    const streamSource = await getVidSrcStream(type, imdbId, season, episode);

    if (streamSource) {
        // AANGEPAST: Bouw de titel op basis van of een proxy is gebruikt.
        let streamTitle = `Nepflix - ${streamSource.sourceDomain}`;
        if (streamSource.wasProxied) {
            streamTitle += ' (via Proxy)';
        }

        const stream = {
            url: streamSource.masterUrl,
            title: streamTitle
        };
        return Promise.resolve({ streams: [stream] });
    }

    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
