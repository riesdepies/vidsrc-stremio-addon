// addon.js

const { addonBuilder } = require("stremio-addon-sdk");
const axios = require('axios'); // Vervang fetch door axios
const cheerio = require('cheerio');

// --- DYNAMISCHE HOST & ICOON URL ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;

// --- MANIFEST ---
const manifest = {
    // ... (rest van manifest blijft hetzelfde)
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

// --- AANGEPASTE PROXY FETCH FUNCTIE MET AXIOS ---
async function fetchViaProxy(url, options) {
    const proxyUrl = host.startsWith('http') ?
        `${host}/api/proxy` :
        `https://${host}/api/proxy`;

    try {
        // Gebruik axios.post om onze proxy aan te roepen
        const proxyRes = await axios.post(proxyUrl, {
            targetUrl: url,
            headers: options.headers || {}
        }, {
            signal: options.signal // axios ondersteunt AbortSignal
        });
        
        // axios plaatst de response data direct in het 'data' veld
        const data = proxyRes.data;

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
        if (error.name !== 'AbortError' && !axios.isCancel(error)) {
            console.error(`[PROXY CLIENT ERROR] Fout bij aanroepen van proxy voor ${url}:`, error.message);
        }
        throw error;
    }
}

// --- findNextUrl en extractM3u8Url blijven ongewijzigd ---
function extractM3u8Url(htmlContent) {
    const regex = /(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/;
    const match = htmlContent.match(regex);
    return match ? match[1] : null;
}

function findNextUrl(html) {
    const $ = cheerio.load(html);
    const iframeSrc = $('iframe').attr('src');
    if (iframeSrc) {
        return iframeSrc;
    }
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

// --- searchDomain en getVidSrcStream blijven ongewijzigd ---
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
            const response = await fetchViaProxy(currentUrl, {
                signal,
                headers: {
                    ...COMMON_HEADERS,
                    'Referer': previousUrl || initialTarget,
                }
            });
            if (!response.ok) break;

            const html = await response.text();
            
            if (!html || typeof html !== 'string') {
                console.error(`[ERROR] Lege of ongeldige HTML ontvangen van ${currentUrl}`);
                break;
            }

            if (step === 1 && html.includes(UNAVAILABLE_TEXT)) {
                controller.abort();
                return null;
            }

            const m3u8Url = extractM3u8Url(html);
            if (m3u8Url) {
                controller.abort();
                return { masterUrl: m3u8Url, sourceDomain: domain };
            }

            let nextIframeSrc = findNextUrl(html);
            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
            } else {
                break;
            }

        } catch (error) {
            if (error.name !== 'AbortError' && !axios.isCancel(error)) {
                console.error(`[ERROR] Fout bij verwerken van domein ${domain} op URL ${currentUrl}:`, error.message);
            }
            break;
        }
    }
    return null;
}

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

// --- builder en defineStreamHandler blijven ongewijzigd ---
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
