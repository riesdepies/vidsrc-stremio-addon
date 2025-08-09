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
// *** VOLLEDIGE LIJST VAN 8 PROXIES ***
const CORS_PROXIES = [
    { name: 'All Origins', template: 'https://api.allorigins.win/raw?url=', needsEncoding: true },
    { name: 'CORSProxy.io', template: 'https://api.corsproxy.io/', needsEncoding: false },
    { name: 'Codetabs', template: 'https://api.codetabs.com/v1/proxy?quest=', needsEncoding: true },
    { name: 'corsmirror.com', template: 'https://corsmirror.com/v1?url=', needsEncoding: true },
    { name: 'Whatever Origin', template: 'https://whateverorigin.org/get?url=', needsEncoding: true },
    { name: 'Tuananh Worker', template: 'https://cors-proxy.tuananh.workers.dev/?', needsEncoding: false },
    { name: 'Novadrone Worker', template: 'https://cors-proxy.novadrone16.workers.dev?url=', needsEncoding: true },
    { name: 'My CORS Proxy', template: 'https://my-cors-proxy-kappa.vercel.app/api/proxy?url=', needsEncoding: true }
];
const MAX_REDIRECTS = 5;
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

// --- HELPER FUNCTIES ---
function extractM3u8Url(html) { const m = html.match(/(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/); return m ? m[1] : null; }
function findNextIframe(html) {
    const rJs = /(?:src:\s*|\.src\s*=\s*)["']([^"']+)["']/g;
    let m;
    while ((m = rJs.exec(html)) !== null) { const u = m[1]; if (u) { const p = u.split('?')[0].split('#')[0]; if (!p.endsWith('.js')) return u; } }
    const rHtml = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/;
    m = html.match(rHtml);
    return m ? m[1] : null;
}

// --- FASE 1: De Start-Race ---
async function raceForInitialPage(type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    const promises = VIDSRC_DOMAINS.map(domain => new Promise(async (resolve, reject) => {
        const initialUrl = `https://${domain}/embed/${apiType}/${imdbId}${type === 'series' ? `/${season}-${episode}` : ''}`;
        try {
            const response = await fetch(initialUrl, { headers: { 'User-Agent': FAKE_USER_AGENT } });
            if (!response.ok) return reject(new Error(`Status ${response.status}`));
            const pageContent = await response.text();
            if (findNextIframe(pageContent) || pageContent.includes("This media is unavailable at the moment.")) {
                resolve({ winnerDomain: domain, pageContent, initialUrl });
            } else {
                reject(new Error("Geen iframe of 'unavailable' bericht"));
            }
        } catch (error) { reject(error); }
    }));

    try {
        return await Promise.any(promises);
    } catch (error) {
        console.log("Fase 1 Mislukt: Geen enkel domein gaf een valide startpagina.");
        return null;
    }
}

// --- FASE 3 & 4: De Diepe Zoektocht (direct of via proxy) ---
async function deepSearch(initialContent, initialUrl, domain, proxy = null) {
    let currentHtml = initialContent;
    let currentUrl = initialUrl;
    let previousUrl = null;

    for (let i = 0; i < MAX_REDIRECTS; i++) {
        const m3u8Url = extractM3u8Url(currentHtml);
        if (m3u8Url) {
            let title = `${domain} (adaptive)`;
            if (proxy) title += ` via ${proxy.name}`;
            return { url: m3u8Url, title };
        }

        const nextIframeSrc = findNextIframe(currentHtml);
        if (!nextIframeSrc) return null; // Doodlopende weg

        previousUrl = currentUrl;
        currentUrl = new URL(nextIframeSrc, currentUrl).href;

        let fetchUrl = currentUrl;
        if (proxy) {
            fetchUrl = proxy.template + (proxy.needsEncoding ? encodeURIComponent(currentUrl) : currentUrl);
        }
        
        const response = await fetch(fetchUrl, { headers: { 'Referer': previousUrl, 'User-Agent': FAKE_USER_AGENT } });
        if (!response.ok) throw new Error(`Status ${response.status} tijdens diep zoeken`);
        currentHtml = await response.text();
    }
    return null; // Max redirects bereikt
}

// --- FASE 4: De Proxy Race ---
async function raceWithProxies(initialUrl, domain) {
    console.log(`Proxy-race gestart voor domein: ${domain}`);
    const promises = CORS_PROXIES.map(proxy =>
        // Let op: De proxy moet de *hele* zoektocht opnieuw starten vanaf de initialUrl.
        // We kunnen niet de pageContent van de directe poging hergebruiken.
        new Promise(async (resolve, reject) => {
            try {
                // Eerst de startpagina ophalen via de proxy
                const initialFetchUrl = proxy.template + (proxy.needsEncoding ? encodeURIComponent(initialUrl) : initialUrl);
                const response = await fetch(initialFetchUrl, { headers: { 'User-Agent': FAKE_USER_AGENT } });
                if (!response.ok) return reject(new Error(`Proxy init faalde: ${proxy.name}`));
                const initialContent = await response.text();
                // Nu de diepe zoektocht starten met de content verkregen via de proxy
                const result = await deepSearch(initialContent, initialUrl, domain, proxy);
                if (result) resolve(result);
                else reject(new Error(`Geen m3u8 via ${proxy.name}`));
            } catch (error) {
                reject(error);
            }
        })
    );
    try {
        return await Promise.any(promises);
    } catch(error) {
        console.log("Fase 4 Mislukt: Alle proxies hebben gefaald.");
        return null;
    }
}

// --- DE DIRIGENT ---
const builder = new addonBuilder(manifest);
builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) return Promise.resolve({ streams: [] });

    // FASE 1: Race voor de startpagina
    const initialResult = await raceForInitialPage(type, imdbId, season, episode);
    if (!initialResult) return Promise.resolve({ streams: [] });
    console.log(`Fase 1 Gewonnen door: ${initialResult.winnerDomain}`);

    // FASE 2: Analyseer winnaar
    if (initialResult.pageContent.includes("This media is unavailable at the moment.")) {
        console.log("Media niet beschikbaar. Zoektocht gestopt.");
        return Promise.resolve({ streams: [] });
    }

    // FASE 3: Directe diepe zoektocht
    try {
        const stream = await deepSearch(initialResult.pageContent, initialResult.initialUrl, initialResult.winnerDomain);
        if (stream) {
            console.log("Stream direct gevonden!");
            return Promise.resolve({ streams: [stream] });
        }
    } catch (error) {
        console.log(`Directe diepe zoektocht mislukt: ${error.message}. Start fallback.`);
    }

    // FASE 4: Fallback naar proxy race
    const stream = await raceWithProxies(initialResult.initialUrl, initialResult.winnerDomain);
    if (stream) {
        console.log("Stream gevonden via proxy-fallback!");
        return Promise.resolve({ streams: [stream] });
    }

    console.log("Alle pogingen zijn mislukt.");
    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
