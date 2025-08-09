const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

// --- DYNAMISCHE HOST & ICOON URL ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;

// --- CACHE CONFIGURATIE ---
const cache = new Map();
// Cache levensduur in milliseconden (4 uur)
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; 

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
        if (url) { const path = url.split('?')[0].split('#')[0]; if (!path.endsWith('.js')) { return url; } }
    }
    return null;
}

function findHtmlIframeSrc(html) {
    const staticRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/;
    const match = html.match(staticRegex);
    return match ? match[1] : null;
}

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
                const response = await fetch(currentUrl, {
                    headers: { 'Referer': previousUrl || initialTarget, 'User-Agent': FAKE_USER_AGENT }
                });
                if (!response.ok) return reject(new Error(`Status ${response.status} op ${domain}`));
                const html = await response.text();
                const m3u8Url = extractM3u8Url(html);
                if (m3u8Url) {
                    return resolve({ url: m3u8Url, title: `${domain} (adaptive)` });
                }
                const nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
                if (nextIframeSrc) {
                    previousUrl = currentUrl;
                    currentUrl = new URL(nextIframeSrc, currentUrl).href;
                } else { break; }
            }
            reject(new Error(`Geen m3u8 gevonden op ${domain}`));
        } catch (error) { reject(error); }
    });
}

async function findFirstAvailableStream(type, imdbId, season, episode) {
    const promises = VIDSRC_DOMAINS.map(domain =>
        getStreamFromDomain(domain, type, imdbId, season, episode)
    );
    try {
        const firstAvailableStream = await Promise.any(promises);
        return firstAvailableStream;
    } catch (error) {
        console.log("Alle domeinen hebben gefaald:", error.errors.map(e => e.message).join(', '));
        return null;
    }
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) {
        return Promise.resolve({ streams: [] });
    }

    // --- CACHE LOGICA ---
    const cached = cache.get(id);
    if (cached && (Date.now() < cached.timestamp + CACHE_TTL_MS)) {
        console.log(`[CACHE HIT] Stream voor ${id} gevonden in cache.`);
        return Promise.resolve({ streams: [cached.stream] });
    }

    console.log(`[CACHE MISS] Geen geldige stream voor ${id} in cache. Nieuwe zoekopdracht...`);
    const stream = await findFirstAvailableStream(type, imdbId, season, episode);

    if (stream) {
        // Voeg de gevonden stream toe aan de cache
        cache.set(id, { stream: stream, timestamp: Date.now() });
        console.log(`[CACHE SET] Stream voor ${id} toegevoegd aan cache.`);
        return Promise.resolve({ streams: [stream] });
    }

    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
