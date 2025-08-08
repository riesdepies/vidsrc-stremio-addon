const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch'); // <-- DEZE REGEL IS TOEGEVOEGD

// --- CONFIGURATIE ---
const VIDSRC_DOMAINS = ["vidsrc.xyz", "vidsrc.in", "vidsrc.io", "vidsrc.me", "vidsrc.net", "vidsrc.pm", "vidsrc.vc", "vidsrc.to", "vidsrc.icu"];
const MAX_REDIRECTS = 10;

// --- MANIFEST ---
const manifest = { "id": "community.vidsrc.ries", "version": "1.0.0", "catalogs": [], "resources": ["stream"], "types": ["movie", "series"], "name": "VidSrc Scraper", "description": "Haalt streamingbronnen op van VidSrc en vergelijkbare domeinen.", "idPrefixes": ["tt"] };

// --- HELPER FUNCTIES ---
function extractM3u8Url(htmlContent) { const regex = /(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/; const match = htmlContent.match(regex); return match ? match[1] : null; }
function findJsIframeSrc(html) { const combinedRegex = /(?:src:\s*|\.src\s*=\s*)["']([^"']+)["']/g; let match; while ((match = combinedRegex.exec(html)) !== null) { const url = match[1]; if (url) { const path = url.split('?')[0].split('#')[0]; if (!path.endsWith('.js')) { return url; } } } return null; }
function findHtmlIframeSrc(html) { const staticRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/; const match = html.match(staticRegex); return match ? match[1] : null; }

// --- HOOFDLOGICA ---
async function getVidSrcStream(type, imdbId, season, episode) { for (const domain of VIDSRC_DOMAINS) { console.log(`[INFO] Proberen van domein: ${domain}`); try { let initialTarget = `https://${domain}/embed/${type}/${imdbId}`; if (type === 'series' && season && episode) { initialTarget += `/${season}/${episode}`; } let currentUrl = initialTarget; let previousUrl = null; for (let step = 1; step <= MAX_REDIRECTS; step++) { console.log(`[${domain} - Stap ${step}] Ophalen van: ${currentUrl}`); const response = await fetch(currentUrl, { headers: { 'Referer': previousUrl || initialTarget } }); if (!response.ok) { throw new Error(`HTTP status ${response.status} voor ${currentUrl}`); } const html = await response.text(); const m3u8Url = extractM3u8Url(html); if (m3u8Url) { console.log(`[SUCCESS] M3U8 GEVONDEN op ${domain}: ${m3u8Url}`); return m3u8Url; } let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html); if (nextIframeSrc) { const nextUrl = new URL(nextIframeSrc, currentUrl).href; console.log(`[INFO] Volgende iframe gevonden: ${nextUrl}`); previousUrl = currentUrl; currentUrl = nextUrl; } else { console.log(`[INFO] Geen M3U8 of volgende iframe gevonden op ${domain}. Stoppen met dit domein.`); break; } } } catch (error) { console.error(`[ERROR] Fout bij verwerken van domein ${domain}:`, error.message); } } console.log('[FAIL] Geen M3U8 stream gevonden na het proberen van alle domeinen.'); return null; }

// --- ADDON SETUP ---
const builder = new addonBuilder(manifest);
builder.defineStreamHandler(async ({ type, id }) => { console.log(`[REQUEST] Stream verzoek voor: type=${type}, id=${id}`); const [imdbId, season, episode] = id.split(':'); if (!imdbId) { return Promise.resolve({ streams: [] }); } const streamUrl = await getVidSrcStream(type, imdbId, season, episode); if (streamUrl) { const stream = { url: streamUrl, title: "VidSrc Stream" }; return Promise.resolve({ streams: [stream] }); } else { return Promise.resolve({ streams: [] }); } });

// Exporteer de addon INTERFACE
module.exports = builder.getInterface();
