const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

// --- DYNAMISCHE HOST & ICOON URL ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;

// --- MANIFEST (VERSIE 1.5.1) ---
const manifest = {
    "id": "community.nepflix.ries",
    "version": "1.5.2",
    "name": "Nepflix",
    "description": "HLS streams van VidSrc",
    "icon": iconUrl,
    "catalogs": [],
    "resources": ["stream"],
    "types": ["movie", "series"],
    "idPrefixes": ["tt"]
};

const VIDSRC_DOMAINS = ["vidsrc.xyz", "vidsrc.in", "vidsrc.io", "vidsrc.me", "vidsrc.net", "vidsrc.pm", "vidsrc.vc", "vidsrc.to", "vidsrc.icu"];

// --- BROWSERPROFIELEN VOOR REALISTISCHE HEADERS ---
const BROWSER_PROFILES = [
    {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
    },
    {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"'
    },
    {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0'
    }
];

function getRandomBrowserProfile() {
    return BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
}

const COMMON_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q-0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'iframe',
};

async function searchDomain(domain, apiType, imdbId, season, episode, controller, requestHeaders) {
    const signal = controller.signal;
    if (signal.aborted) return null;

    console.log(`[SEARCH] Asking resolver for domain: ${domain}`);
    const initialTarget = `https://${domain}/embed/${apiType}/${imdbId}${apiType === 'tv' && season && episode ? `/${season}-${episode}` : ''}`;
    
    const resolverUrl = host.startsWith('http') ? `${host}/api/resolve` : `https://${host}/api/resolve`;

    try {
        const response = await fetch(resolverUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                targetUrl: initialTarget,
                sourceDomain: domain,
                headers: requestHeaders
            }),
            signal
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.log(`[RESOLVER CLIENT] Resolver failed for ${domain} with status ${response.status}: ${errorBody}`);
            if (response.status === 499) { // Special code for 'Unavailable'
                 console.log(`[RESOLVER CLIENT] Media unavailable on domain ${domain}. Aborting all searches.`);
                 controller.abort();
            }
            return null;
        }

        const data = await response.json();
        if (data.masterUrl) {
            console.log(`[SUCCESS] Resolver found m3u8 for domain ${domain}`);
            controller.abort();
            // Stuur het volledige resultaatobject door, inclusief de bestandsnaam
            return { 
                masterUrl: data.masterUrl, 
                sourceDomain: data.sourceDomain,
                filename: data.filename 
            };
        }
        return null;
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error(`[RESOLVER CLIENT] Error calling resolver for ${domain}:`, error.message);
        }
        return null;
    }
}

function getVidSrcStream(type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    const controller = new AbortController();
    const MAX_CONCURRENT_SEARCHES = 3;

    const requestHeaders = { ...COMMON_HEADERS, ...getRandomBrowserProfile() };
    
    const domainQueue = [...VIDSRC_DOMAINS].sort(() => 0.5 - Math.random());
    
    console.log(`[GETSTREAM] Starting parallel search (max ${MAX_CONCURRENT_SEARCHES}) for ${imdbId} with UA: ${requestHeaders['User-Agent']}`);

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
            searchDomain(domain, apiType, imdbId, season, episode, controller, requestHeaders)
                .then(result => {
                    if (result && !resultFound) {
                        resultFound = true;
                        resolve(result);
                    }
                })
                .catch(err => { if (err.name !== 'AbortError') console.error(`[GETSTREAM] Error searching domain ${domain}:`, err.message); })
                .finally(() => {
                    activeSearches--;
                    launchNext();
                });
        };
        for (let i = 0; i < MAX_CONCURRENT_SEARCHES && i < VIDSRC_DOMAINS.length; i++) {
            launchNext();
        }
    });
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) return Promise.resolve({ streams: [] });
    const streamSource = await getVidSrcStream(type, imdbId, season, episode);
    if (streamSource) {
        // Gebruik de gevonden bestandsnaam als titel. Gebruik het domein als fallback.
        const title = streamSource.filename || `${streamSource.sourceDomain}`;
        const stream = { 
            url: streamSource.masterUrl, 
            title: title
        };
        return Promise.resolve({ streams: [stream] });
    }
    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();