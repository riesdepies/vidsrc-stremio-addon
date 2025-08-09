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
// *** TOEGEVOEGD: Standaard User-Agent om blokkades te voorkomen ***
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
            let m3u8Url = null;

            for (let step = 1; step <= MAX_REDIRECTS; step++) {
                const response = await fetch(currentUrl, {
                    // *** AANGEPAST: Headers toegevoegd ***
                    headers: { 
                        'Referer': previousUrl || initialTarget,
                        'User-Agent': FAKE_USER_AGENT
                    }
                });
                if (!response.ok) break;
                const html = await response.text();
                const foundM3u8 = extractM3u8Url(html);
                if (foundM3u8) {
                    m3u8Url = foundM3u8;
                    break;
                }
                let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
                if (nextIframeSrc) {
                    previousUrl = currentUrl;
                    currentUrl = new URL(nextIframeSrc, currentUrl).href;
                } else {
                    break;
                }
            }

            if (m3u8Url) {
                try {
                    // *** DIT IS DE TWEEDE FETCH, NU OOK MET HEADERS ***
                    const m3u8Response = await fetch(m3u8Url, {
                        headers: {
                            'Referer': currentUrl, // De laatst bekende referer
                            'User-Agent': FAKE_USER_AGENT
                        }
                    });
                    if (!m3u8Response.ok) throw new Error('M3U8 fetch failed');
                    const m3u8Content = await m3u8Response.text();
                    
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
                        const height = bestStream.resolution ? parseInt(bestStream.resolution.split('x')[1], 10) : 0;
                        let label = 'SD';
                        if (height >= 2160) label = '4K';
                        else if (height >= 1080) label = '1080p';
                        else if (height >= 720) label = '720p';
                        else if (height >= 480) label = '480p';
                        
                        return {
                            url: new URL(bestStream.url, m3u8Url).href,
                            title: `${domain} (${label})`
                        };
                    }
                } catch (parseError) {
                    console.error(`[WARN] M3U8 parsen mislukt, val terug naar master playlist: ${parseError.message}`);
                    return {
                        url: m3u8Url,
                        title: `${domain} (Auto)`
                    };
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
    const stream = await getVidSrcStream(type, imdbId, season, episode);
    if (stream) {
        return Promise.resolve({ streams: [stream] });
    }
    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
