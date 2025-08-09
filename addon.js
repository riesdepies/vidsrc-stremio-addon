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

function extractM3u8Url(htmlContent) { const regex = /(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/; const match = htmlContent.match(regex); return match ? match[1] : null; }
function findJsIframeSrc(html) { const r = /(?:src:\s*|\.src\s*=\s*)["']([^"']+)["']/g; let m; while ((m = r.exec(html)) !== null) { const u = m[1]; if (u) { const p = u.split('?')[0].split('#')[0]; if (!p.endsWith('.js')) return u; } } return null; }
function findHtmlIframeSrc(html) { const r = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/; const m = html.match(r); return m ? m[1] : null; }

// --- FASE 1: De Start-Race ---
async function raceForInitialPage(type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    const promises = VIDSRC_DOMAINS.map(domain => new Promise(async (resolve, reject) => {
        const initialUrl = `https://${domain}/embed/${apiType}/${imdbId}${type === 'series' ? `/${season}-${episode}` : ''}`;
        try {
            const response = await fetch(initialUrl, { headers: { 'User-Agent': FAKE_USER_AGENT } });
            if (!response.ok) return reject(new Error(`Status ${response.status} for ${domain}`));
            const html = await response.text();
            if (html.includes("This media is unavailable at the moment.")) {
                return resolve({ status: 'unavailable', domain });
            }
            if (findHtmlIframeSrc(html) || findJsIframeSrc(html)) {
                return resolve({ status: 'found_iframe', domain, html, initialUrl });
            }
            reject(new Error(`No iframe or unavailable message on ${domain}`));
        } catch (error) {
            reject(error);
        }
    }));
    try {
        console.log("Fase 1: Start-Race begonnen...");
        const winner = await Promise.any(promises);
        console.log(`Fase 1: Winnaar is ${winner.domain} met status: ${winner.status}`);
        return winner;
    } catch (error) {
        console.error("Fase 1: Start-Race mislukt voor alle domeinen.");
        return null;
    }
}

// --- FASE 3: Diep Zoeken (Directe Poging) ---
async function continueSearchDirectly(winner) {
    console.log(`Fase 3: Directe zoektocht gestart op ${winner.domain}...`);
    let { html, domain, initialUrl } = winner;
    try {
        for (let step = 0; step < MAX_REDIRECTS; step++) {
            const m3u8Url = extractM3u8Url(html);
            if (m3u8Url) {
                console.log(`Fase 3: Succes! M3U8 gevonden op ${domain}.`);
                return { url: m3u8Url, title: `${domain} (adaptive)` };
            }
            const nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            if (!nextIframeSrc) break;
            
            const nextUrl = new URL(nextIframeSrc, initialUrl).href;
            const response = await fetch(nextUrl, { headers: { 'Referer': initialUrl, 'User-Agent': FAKE_USER_AGENT }});
            if (!response.ok) throw new Error(`Status ${response.status} in redirect`);
            html = await response.text();
            initialUrl = nextUrl; // Update referer for next hop
        }
    } catch (error) {
        console.error(`Fase 3: Directe zoektocht mislukt op ${domain}:`, error.message);
    }
    return null;
}

// --- FASE 4: Proxy Fallback Race ---
async function raceWithProxies(domain, type, imdbId, season, episode) {
    console.log(`Fase 4: Proxy-race gestart voor ${domain}...`);
    const promises = CORS_PROXIES.map(proxy => new Promise(async (resolve, reject) => {
        try {
            const apiType = type === 'series' ? 'tv' : 'movie';
            let targetUrl = `https://${domain}/embed/${apiType}/${imdbId}${type === 'series' ? `/${season}-${episode}` : ''}`;
            let currentUrl = targetUrl;
            let previousUrl = null;

            for (let step = 0; step < MAX_REDIRECTS; step++) {
                const proxyUrlPart = proxy.needsEncoding ? encodeURIComponent(currentUrl) : currentUrl;
                const fetchUrl = proxy.template + proxyUrlPart;
                
                const response = await fetch(fetchUrl, { headers: { 'User-Agent': FAKE_USER_AGENT } });
                if (!response.ok) return reject(new Error(`Proxy ${proxy.name} failed with status ${response.status}`));
                
                const html = await response.text();
                const m3u8Url = extractM3u8Url(html);
                if (m3u8Url) {
                    return resolve({ url: m3u8Url, title: `${domain} (adaptive via ${proxy.name})` });
                }
                
                const nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
                if (!nextIframeSrc) break;
                
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
            }
            reject(new Error(`Proxy ${proxy.name} found no m3u8`));
        } catch (error) {
            reject(error);
        }
    }));
    try {
        const winner = await Promise.any(promises);
        console.log(`Fase 4: Proxy-race gewonnen! ${winner.title}`);
        return winner;
    } catch (error) {
        console.error("Fase 4: Proxy-race mislukt voor alle proxies.");
        return null;
    }
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) { return Promise.resolve({ streams: [] }); }

    // Fase 1: Race om de eerste valide pagina te vinden
    const initialWinner = await raceForInitialPage(type, imdbId, season, episode);
    if (!initialWinner) return Promise.resolve({ streams: [] });

    // Fase 2: Analyseer de winnaar
    if (initialWinner.status === 'unavailable') {
        console.log(`Zoektocht gestopt: ${initialWinner.domain} meldt dat de media niet beschikbaar is.`);
        return Promise.resolve({ streams: [] });
    }

    // Fase 3: Probeer de zoektocht direct voort te zetten
    let stream = await continueSearchDirectly(initialWinner);

    // Fase 4: Als direct mislukt, start de proxy-race
    if (!stream) {
        stream = await raceWithProxies(initialWinner.domain, type, imdbId, season, episode);
    }
    
    if (stream) {
        return Promise.resolve({ streams: [stream] });
    }

    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
