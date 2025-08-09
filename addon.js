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
// *** ALLE 8 PROXIES TOEGEVOEGD ***
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

function extractM3u8Url(htmlContent) { const regex = /(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/; const match = htmlContent.match(regex); return match ? match[1] : null; }
function findJsIframeSrc(html) { const r = /(?:src:\s*|\.src\s*=\s*)["']([^"']+)["']/g; let m; while ((m = r.exec(html)) !== null) { const u = m[1]; if (u) { const p = u.split('?')[0].split('#')[0]; if (!p.endsWith('.js')) return u; } } return null; }
function findHtmlIframeSrc(html) { const r = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/; const m = html.match(r); return m ? m[1] : null; }

// FASE 1: Race om de eerste valide pagina te vinden
async function findInitialWinner(type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    const promises = VIDSRC_DOMAINS.map(domain => new Promise(async (resolve, reject) => {
        try {
            let initialTarget = `https://${domain}/embed/${apiType}/${imdbId}`;
            if (type === 'series' && season && episode) { initialTarget += `/${season}-${episode}`; }
            const response = await fetch(initialTarget, { headers: { 'User-Agent': FAKE_USER_AGENT } });
            if (!response.ok) return reject(new Error(`Status ${response.status}`));
            const html = await response.text();
            if (html.includes("This media is unavailable at the moment.")) {
                return resolve({ domain, isUnavailable: true });
            }
            const firstIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            if (firstIframeSrc) {
                return resolve({ domain, initialTarget, firstIframeSrc });
            }
            reject(new Error("Geen iframe of 'unavailable' bericht gevonden."));
        } catch (error) { reject(error); }
    }));
    try { return await Promise.any(promises); }
    catch (e) { console.log("Fase 1 mislukt: geen enkel domein gaf een valide eerste pagina."); return null; }
}

// FASE 3: Volg de iframe-keten vanaf een startpunt (directe poging)
async function findM3u8FromChain(startUrl, initialTarget, domain) {
    try {
        let currentUrl = startUrl;
        let previousUrl = initialTarget;
        for (let step = 1; step <= MAX_REDIRECTS; step++) {
            const response = await fetch(currentUrl, { headers: { 'Referer': previousUrl, 'User-Agent': FAKE_USER_AGENT }});
            if (!response.ok) throw new Error(`Status ${response.status}`);
            const html = await response.text();
            const m3u8Url = extractM3u8Url(html);
            if (m3u8Url) return { url: m3u8Url, title: `${domain} (adaptive)` };
            const nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
            } else { break; }
        }
    } catch (error) { console.log(`Fase 3 (direct) mislukt voor ${domain}: ${error.message}`); }
    return null;
}

// HULPFUNCTIE VOOR FASE 4: Zoektocht via een specifieke proxy
function getStreamViaProxy(winnerDomain, type, imdbId, season, episode, proxy) {
    return new Promise(async (resolve, reject) => {
        try {
            const apiType = type === 'series' ? 'tv' : 'movie';
            let initialTarget = `https://${winnerDomain}/embed/${apiType}/${imdbId}`;
            if (type === 'series' && season && episode) { initialTarget += `/${season}-${episode}`; }
            
            let currentUrl = initialTarget;
            let previousUrl = null;

            for (let step = 1; step <= MAX_REDIRECTS + 1; step++) {
                const urlPart = proxy.needsEncoding ? encodeURIComponent(currentUrl) : currentUrl;
                const fetchUrl = proxy.template + urlPart;
                const response = await fetch(fetchUrl, { headers: { 'User-Agent': FAKE_USER_AGENT } });

                if (!response.ok) return reject(new Error(`Proxy ${proxy.name} faalde met status ${response.status}`));
                
                const html = await response.text();
                const m3u8Url = extractM3u8Url(html);
                if (m3u8Url) {
                    return resolve({ url: m3u8Url, title: `${winnerDomain} (via ${proxy.name})` });
                }
                const nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
                if (nextIframeSrc) {
                    previousUrl = currentUrl;
                    currentUrl = new URL(nextIframeSrc, currentUrl).href;
                } else { break; }
            }
            reject(new Error(`Proxy ${proxy.name} kon geen m3u8 vinden`));
        } catch (error) { reject(error); }
    });
}

// FASE 4: Proxy-race op het winnende domein
async function tryProxiedRace(winnerDomain, type, imdbId, season, episode) {
    console.log(`Start proxy-race op winnend domein: ${winnerDomain}`);
    const promises = CORS_PROXIES.map(proxy => getStreamViaProxy(winnerDomain, type, imdbId, season, episode, proxy));
    try {
        return await Promise.any(promises);
    } catch (e) {
        console.log("Fase 4 mislukt: geen enkele proxy was succesvol.");
        return null;
    }
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) return Promise.resolve({ streams: [] });

    // FASE 1 & 2
    const winner = await findInitialWinner(type, imdbId, season, episode);
    if (!winner) return Promise.resolve({ streams: [] });
    if (winner.isUnavailable) {
        console.log(`Media niet beschikbaar op winnend domein ${winner.domain}. Stoppen.`);
        return Promise.resolve({ streams: [] });
    }
    console.log(`Fase 1 gewonnen door: ${winner.domain}. Start diepe zoektocht.`);

    // FASE 3
    const startUrl = new URL(winner.firstIframeSrc, winner.initialTarget).href;
    let stream = await findM3u8FromChain(startUrl, winner.initialTarget, winner.domain);

    // FASE 4 (indien nodig)
    if (!stream) {
        console.log(`Directe zoektocht mislukt. Start fallback proxy-race op ${winner.domain}.`);
        stream = await tryProxiedRace(winner.domain, type, imdbId, season, episode);
    }

    if (stream) {
        console.log(`Stream gevonden: ${stream.title}`);
        return Promise.resolve({ streams: [stream] });
    }

    console.log("Geen stream gevonden na alle pogingen.");
    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
