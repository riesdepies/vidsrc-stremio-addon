const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

// --- DYNAMISCHE HOST & ICOON URL ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;

// --- CONFIGURATIE ---
const PLAYER_USER_AGENT = 'VLC/3.0.17.4 LibVLC/3.0.17.4';
const VIDSRC_DOMAINS = ["vidsrc.xyz", "vidsrc.in", "vidsrc.io", "vidsrc.me", "vidsrc.net", "vidsrc.pm", "vidsrc.vc", "vidsrc.to", "vidsrc.icu"];
const MAX_REDIRECTS = 5;

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

function extractM3u8Url(htmlContent) {
    const regex = /(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/;
    const match = htmlContent.match(regex);
    return match ? match[1] : null;
}

function findJsIframeSrc(html) {
    const combinedRegex = /(?:src:\s*|\.src\s*=\s*)["']([^"']+)["']/g;
    let match;
    while ((match = combinedRegex.exec(html)) !== null) { const url = match[1]; if (url) { const path = url.split('?')[0].split('#')[0]; if (!path.endsWith('.js')) { return url; } } }
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
            if (type === 'series' && season && episode) { initialTarget += `/${season}-${episode}`; }
            let currentUrl = initialTarget;
            let previousUrl = null;
            for (let step = 1; step <= MAX_REDIRECTS; step++) {
                const response = await fetch(currentUrl, {
                    headers: { 
                        'Referer': previousUrl || initialTarget,
                        'User-Agent': PLAYER_USER_AGENT 
                    }
                });
                if (!response.ok) { throw new Error(`HTTP status ${response.status} voor ${currentUrl}`); }
                const html = await response.text();
                const m3u8Url = extractM3u8Url(html);
                if (m3u8Url) {
                    // *** AANGEPAST: Geef ook de referer (de huidige URL) terug ***
                    return { masterUrl: m3u8Url, sourceDomain: domain, refererUrl: currentUrl };
                }
                let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
                if (nextIframeSrc) {
                    const nextUrl = new URL(nextIframeSrc, currentUrl).href;
                    previousUrl = currentUrl;
                    currentUrl = nextUrl;
                } else { break; }
            }
        } catch (error) { console.error(`[ERROR] Fout bij verwerken van domein ${domain}:`, error.message); }
    }
    return null;
}

// *** AANGEPAST: Functie accepteert nu een refererUrl ***
async function getBestStreamFromM3u8(masterUrl, refererUrl) {
    try {
        // *** AANGEPAST: Gebruik de correcte referer bij het fetchen van de M3U8 ***
        const response = await fetch(masterUrl, { 
            headers: { 
                'User-Agent': PLAYER_USER_AGENT,
                'Referer': refererUrl 
            } 
        });
        if (!response.ok) return null;
        const m3u8Content = await response.text();
        const lines = m3u8Content.trim().split('\n');
        let bestStream = { bandwidth: 0, url: null, resolution: null };
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
                const infoLine = lines[i];
                const urlLine = lines[i + 1];
                const bandwidthMatch = infoLine.match(/BANDWIDTH=(\d+)/);
                const resolutionMatch = infoLine.match(/RESOLUTION=([^,]+)/);
                if (bandwidthMatch && urlLine && !urlLine.startsWith('#')) {
                    const bandwidth = parseInt(bandwidthMatch[1], 10);
                    if (bandwidth > bestStream.bandwidth) {
                        bestStream = {
                            bandwidth: bandwidth,
                            url: urlLine.trim(),
                            resolution: resolutionMatch ? resolutionMatch[1] : null
                        };
                    }
                }
            }
        }
        if (bestStream.url) {
            return {
                streamUrl: new URL(bestStream.url, masterUrl).href,
                resolution: bestStream.resolution
            };
        }
        return null;
    } catch (error) { console.error(`[ERROR] Kon M3U8 niet parsen (${masterUrl}):`, error.message); return null; }
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) { return Promise.resolve({ streams: [] }); }

    const streamSource = await getVidSrcStream(type, imdbId, season, episode);

    if (streamSource) {
        // *** AANGEPAST: Haal ook de refererUrl op ***
        const { masterUrl, sourceDomain, refererUrl } = streamSource;
        // *** AANGEPAST: Geef de refererUrl mee ***
        const bestStreamInfo = await getBestStreamFromM3u8(masterUrl, refererUrl);

        if (bestStreamInfo) {
            const { streamUrl, resolution } = bestStreamInfo;
            const title = resolution ? `${sourceDomain} (${resolution})` : `${sourceDomain} (HD)`;
            const stream = {
                url: streamUrl,
                title: title
            };
            return Promise.resolve({ streams: [stream] });
        } else {
            const stream = {
                url: masterUrl,
                title: `${sourceDomain} (Auto)`
            };
            return Promise.resolve({ streams: [stream] });
        }
    }

    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
