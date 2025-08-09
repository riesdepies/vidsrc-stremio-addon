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
            if (!path.endsWith('.js')) {
                return url;
            }
        }
    }
    return null;
}

function findHtmlIframeSrc(html) {
    const staticRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/;
    const match = html.match(staticRegex);
    return match ? match[1] : null;
}

async function getVidSrcStream(type, imdbId, season, episode) {
    const apiType = type === 'series' ? 'tv' : 'movie';
    for (const domain of VIDSRC_DOMAINS) {
        try {
            let initialTarget = `https://${domain}/embed/${apiType}/${imdbId}`;
            if (type === 'series' && season && episode) {
                initialTarget += `/${season}-${episode}`;
            }
            let currentUrl = initialTarget;
            let previousUrl = null;
            for (let step = 1; step <= MAX_REDIRECTS; step++) {
                const response = await fetch(currentUrl, {
                    headers: { 'Referer': previousUrl || initialTarget }
                });
                if (!response.ok) {
                    throw new Error(`HTTP status ${response.status} voor ${currentUrl}`);
                }
                const html = await response.text();
                const m3u8Url = extractM3u8Url(html);
                if (m3u8Url) {
                    // Geef een object terug met de gevonden URL en het brondomein
                    return { masterUrl: m3u8Url, sourceDomain: domain };
                }
                let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
                if (nextIframeSrc) {
                    const nextUrl = new URL(nextIframeSrc, currentUrl).href;
                    previousUrl = currentUrl;
                    currentUrl = nextUrl;
                } else {
                    break;
                }
            }
        } catch (error) {
            console.error(`[ERROR] Fout bij verwerken van domein ${domain}:`, error.message);
        }
    }
    return null;
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) {
        return Promise.resolve({ streams: [] });
    }

    // Vraag de bron op (URL + domein)
    const streamSource = await getVidSrcStream(type, imdbId, season, episode);

    if (streamSource) {
        // Maak direct een stream aan met de master M3U8 URL
        const stream = {
            url: streamSource.masterUrl,
            title: streamSource.sourceDomain // Toon alleen het domein als titel
        };
        return Promise.resolve({ streams: [stream] });
    }

    // Geen stream gevonden
    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
