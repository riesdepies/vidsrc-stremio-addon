const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');
const AbortController = require('abort-controller'); // Nodig voor timeouts in node-fetch

// --- DYNAMISCHE HOST & ICOON URL ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;

// --- MANIFEST ---
const manifest = {
    "id": "community.nepflix.ries",
    "version": "1.2.0", // Versie verhoogd vanwege significante wijzigingen
    "name": "Nepflix",
    "description": "HLS streams van VidSrc - sneller en robuuster.",
    "icon": iconUrl,
    "catalogs": [],
    "resources": ["stream"],
    "types": ["movie", "series"],
    "idPrefixes": ["tt"]
};

const VIDSRC_DOMAINS = ["vidsrc.to", "vidsrc.xyz", "vidsrc.me", "vidsrc.net", "vidsrc.icu"];
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT = 5000; // 5 seconden timeout per request

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    'Accept-Language': 'en-US,en;q=0.9,nl;q=0.8',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'iframe',
    'Upgrade-Insecure-Requests': '1',
};

// --- VERBETERING: Functies die Regex gebruiken voor HTML-parsing ---
function extractM3u8Url(htmlContent) {
    const regex = /(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/;
    const match = htmlContent.match(regex);
    return match ? match[1] : null;
}

function findIframeSrcWithRegex(html) {
    // Prioriteit 1: Zoek naar een standaard HTML <iframe> tag. Dit is het meest betrouwbaar.
    const staticRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/;
    const staticMatch = html.match(staticRegex);
    if (staticMatch && staticMatch[1]) {
        return staticMatch[1];
    }

    // Prioriteit 2 (Fallback): Zoek naar JavaScript-gebaseerde src-toewijzingen.
    const scriptRegex = /(?:src:\s*|\.src\s*=\s*)["']([^"']+)["']/g;
    let scriptMatch;
    while ((scriptMatch = scriptRegex.exec(html)) !== null) {
        const url = scriptMatch[1];
        if (url) {
            // Zorg ervoor dat we geen .js-bestand als bron-URL pakken
            const path = url.split('?')[0].split('#')[0];
            if (!path.endsWith('.js')) {
                return url; // Retourneer de eerste geldige, niet-.js URL
            }
        }
    }
    
    return null; // Geen enkele bron gevonden
}


// --- Functie die één domein probeert met timeout ---
async function tryDomain(domain, type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    let initialTarget = `https://${domain}/embed/${apiType}/${imdbId}`;
    if (type === 'series' && season && episode) {
        initialTarget += `/${season}-${episode}`;
    }

    let currentUrl = initialTarget;
    let previousUrl = null;

    for (let step = 1; step <= MAX_REDIRECTS; step++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        try {
            const response = await fetch(currentUrl, {
                signal: controller.signal,
                headers: {
                    ...COMMON_HEADERS,
                    'Referer': previousUrl || `https://${domain}/`,
                }
            });

            if (!response.ok) throw new Error(`Status code ${response.status}`);
            
            const html = await response.text();
            const m3u8Url = extractM3u8Url(html);

            if (m3u8Url) {
                return { masterUrl: m3u8Url, sourceDomain: domain };
            }
            
            // Gebruik de nieuwe regex-functie
            const nextIframeSrc = findIframeSrcWithRegex(html);

            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
            } else {
                throw new Error("Geen m3u8 of volgende iframe gevonden.");
            }
        } finally {
            clearTimeout(timeout);
        }
    }
    throw new Error(`Maximale redirects (${MAX_REDIRECTS}) bereikt voor domein ${domain}`);
}


const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) {
        return { streams: [] };
    }

    // Probeer alle domeinen parallel
    const promises = VIDSRC_DOMAINS.map(domain => 
        tryDomain(domain, type, imdbId, season, episode)
    );

    try {
        // Wacht op de EERSTE succesvolle promise
        const streamSource = await Promise.any(promises);
        
        if (streamSource) {
            const stream = {
                url: streamSource.masterUrl,
                title: `Nepflix - ${streamSource.sourceDomain}`,
                behaviorHints: {
                    "proxyHeaders": { "request": COMMON_HEADERS }
                }
            };
            return { streams: [stream] };
        }
    } catch (error) {
        // Promise.any gooit een AggregateError als alle promises falen
        console.error("Alle domeinen zijn gefaald.", error.errors || error.message);
    }
    
    return { streams: [] };
});

module.exports = builder.getInterface();
