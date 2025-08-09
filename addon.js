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

const CORS_PROXIES = [
    { name: 'All Origins', template: 'https://api.allorigins.win/raw?url=', needsEncoding: true },
    { name: 'CORSProxy.io', template: 'https://api.corsproxy.io/', needsEncoding: false },
    { name: 'Codetabs', template: 'https://api.codetabs.com/v1/proxy?quest=', needsEncoding: true },
    { name: 'corsmirror.com', template: 'https://corsmirror.com/v1?url=', needsEncoding: true },
    { name: 'Whatever Origin', template: 'https://whateverorigin.org/get?url=', needsEncoding: true },
    { name: 'Tuananh Worker', template: 'https://cors-proxy.tuananh.workers.dev/?', needsEncoding: false }
];

function extractM3u8Url(html) { const m = html.match(/(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/); return m ? m[1] : null; }
function findJsIframeSrc(html) { const r = /(?:src:\s*|\.src\s*=\s*)["']([^"']+)["']/g; let m; while ((m = r.exec(html)) !== null) { const u = m[1]; if (u) { const p = u.split('?')[0].split('#')[0]; if (!p.endsWith('.js')) return u; } } return null; }
function findHtmlIframeSrc(html) { const m = html.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/); return m ? m[1] : null; }

// FASE 1: Haalt alleen de EERSTE pagina op en valideert deze.
function getInitialPage(domain, type, imdbId, season, episode) {
    return new Promise(async (resolve, reject) => {
        const apiType = type === 'series' ? 'tv' : 'movie';
        let initialUrl = `https://${domain}/embed/${apiType}/${imdbId}`;
        if (type === 'series' && season && episode) { initialUrl += `/${season}-${episode}`; }
        
        try {
            const response = await fetch(initialUrl, { headers: { 'User-Agent': FAKE_USER_AGENT } });
            if (!response.ok) return reject(new Error(`Status ${response.status} op ${domain}`));
            
            const html = await response.text();
            
            const hasIframe = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            const isUnavailable = html.includes("This media is unavailable at the moment.");

            if (hasIframe || isUnavailable) {
                // Succes! We hebben een valide pagina.
                resolve({ domain, html, isUnavailable });
            } else {
                reject(new Error(`Geen iframe of 'unavailable' bericht op ${domain}`));
            }
        } catch (error) {
            reject(error);
        }
    });
}

// FASE 3 & 4: Zoekt de volledige keten af voor een specifiek domein, optioneel via een proxy.
function findM3u8InChain(domain, type, imdbId, season, episode, proxy = null) {
     return new Promise(async (resolve, reject) => {
        try {
            const apiType = type === 'series' ? 'tv' : 'movie';
            let targetUrl = `https://${domain}/embed/${apiType}/${imdbId}`;
            if (type === 'series' && season && episode) { targetUrl += `/${season}-${episode}`; }

            let currentUrl = targetUrl;
            let previousUrl = null;

            for (let step = 1; step <= MAX_REDIRECTS; step++) {
                let fetchUrl = currentUrl;
                let referer = previousUrl || targetUrl;
                if (proxy) {
                    const urlPart = proxy.needsEncoding ? encodeURIComponent(currentUrl) : currentUrl;
                    fetchUrl = proxy.template + urlPart;
                }
                const response = await fetch(fetchUrl, { headers: { 'Referer': referer, 'User-Agent': FAKE_USER_AGENT }});
                if (!response.ok) { return reject(new Error(`Status ${response.status} op ${domain}` + (proxy ? ` via ${proxy.name}` : ''))); }
                
                const html = await response.text();
                const m3u8Url = extractM3u8Url(html);
                if (m3u8Url) {
                    let title = `${domain} (adaptive)`;
                    if (proxy) { title += ` via ${proxy.name}`; }
                    return resolve({ url: m3u8Url, title: title });
                }

                const nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
                if (nextIframeSrc) {
                    previousUrl = currentUrl;
                    currentUrl = new URL(nextIframeSrc, currentUrl).href;
                } else { break; }
            }
            reject(new Error(`Geen m3u8 gevonden in keten van ${domain}` + (proxy ? ` via ${proxy.name}` : '')));
        } catch (error) { reject(error); }
    });
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) { return Promise.resolve({ streams: [] }); }

    // --- FASE 1: De Start-Race ---
    let winningPageInfo;
    try {
        const racePromises = VIDSRC_DOMAINS.map(d => getInitialPage(d, type, imdbId, season, episode));
        winningPageInfo = await Promise.any(racePromises);
        console.log(`Fase 1 gewonnen door: ${winningPageInfo.domain}`);
    } catch (error) {
        console.log("Fase 1: Geen enkel domein gaf een valide eerste pagina. Stoppen.");
        return Promise.resolve({ streams: [] });
    }

    // --- FASE 2: Analyse van de Winnaar ---
    if (winningPageInfo.isUnavailable) {
        console.log(`Fase 2: Domein ${winningPageInfo.domain} meldt 'media unavailable'. Stoppen.`);
        return Promise.resolve({ streams: [] });
    }
    
    // --- FASE 3: Diep Zoeken (Directe Poging) ---
    try {
        console.log(`Fase 3: Start diepe zoektocht op ${winningPageInfo.domain}...`);
        const stream = await findM3u8InChain(winningPageInfo.domain, type, imdbId, season, episode, null);
        console.log(`Fase 3: Succes! Stream gevonden op ${winningPageInfo.domain}.`);
        return Promise.resolve({ streams: [stream] });
    } catch (error) {
        console.log(`Fase 3: Directe zoektocht op ${winningPageInfo.domain} mislukt. Fout: ${error.message}`);
        console.log("Schakelen over naar Fase 4: Proxy-Fallback Race.");
    }

    // --- FASE 4: Proxy-Fallback Race ---
    try {
        const proxyRacePromises = CORS_PROXIES.map(p => findM3u8InChain(winningPageInfo.domain, type, imdbId, season, episode, p));
        const stream = await Promise.any(proxyRacePromises);
        console.log(`Fase 4: Succes! Stream gevonden via proxy.`);
        return Promise.resolve({ streams: [stream] });
    } catch (error) {
        console.log(`Fase 4: Alle proxies hebben gefaald voor domein ${winningPageInfo.domain}. Stoppen.`);
        return Promise.resolve({ streams: [] });
    }
});

module.exports = builder.getInterface();
