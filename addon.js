const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

// --- MANIFEST ---
const manifest = {
    "id": "community.nepflix.ries", // ID aangepast voor de nieuwe naam
    "version": "1.1.0", // Versienummer verhoogd
    "name": "Nepflix", // NIEUWE NAAM
    "description": "HLS streams van VidSrc", // NIEUWE OMSCHRIJVING
    "icon": "/logo.svg", // VERWIJZING NAAR HET LOGO
    "resources": ["stream"],
    "types": ["movie", "series"],
    "idPrefixes": ["tt"]
};

const VIDSRC_DOMAINS = ["vidsrc.xyz", "vidsrc.in", "vidsrc.io", "vidsrc.me", "vidsrc.net", "vidsrc.pm", "vidsrc.vc", "vidsrc.to", "vidsrc.icu"];
const MAX_REDIRECTS = 10;
function extractM3u8Url(htmlContent) { const regex = /(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/; const match = htmlContent.match(regex); return match ? match[1] : null; }
function findJsIframeSrc(html) { const combinedRegex = /(?:src:\s*|\.src\s*=\s*)["']([^"']+)["']/g; let match; while ((match = combinedRegex.exec(html)) !== null) { const url = match[1]; if (url) { const path = url.split('?')[0].split('#')[0]; if (!path.endsWith('.js')) { return url; } } } return null; }
function findHtmlIframeSrc(html) { const staticRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/; const match = html.match(staticRegex); return match ? match[1] : null; }
async function getVidSrcStream(type, imdbId, season, episode) { for (const domain of VIDSRC_DOMAINS) { try { let initialTarget = `https://${domain}/embed/${type}/${imdbId}`; if (type === 'series' && season && episode) { initialTarget += `/${season}/${episode}`; } let currentUrl = initialTarget; let previousUrl = null; for (let step = 1; step <= MAX_REDIRECTS; step++) { const response = await fetch(currentUrl, { headers: { 'Referer': previousUrl || initialTarget } }); if (!response.ok) { throw new Error(`HTTP status ${response.status} voor ${currentUrl}`); } const html = await response.text(); const m3u8Url = extractM3u8Url(html); if (m3u8Url) { return m3u8Url; } let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html); if (nextIframeSrc) { const nextUrl = new URL(nextIframeSrc, currentUrl).href; previousUrl = currentUrl; currentUrl = nextUrl; } else { break; } } } catch (error) { console.error(`[ERROR] Fout bij verwerken van domein ${domain}:`, error.message); } } return null; }
const builder = new addonBuilder(manifest);
builder.defineStreamHandler(async ({ type, id }) => { const [imdbId, season, episode] = id.split(':'); if (!imdbId) { return Promise.resolve({ streams: [] }); } const streamUrl = await getVidSrcStream(type, imdbId, season, episode); if (streamUrl) { const stream = { url: streamUrl, title: "Nepflix Stream" }; return Promise.resolve({ streams: [stream] }); } else { return Promise.resolve({ streams: [] }); } });
module.exports = builder.getInterface();
