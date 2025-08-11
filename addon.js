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

// *** TOEGEVOEGD: Uitgebreide set headers om een browser te simuleren ***
const COMMON_HEADERS = {
'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
'Accept-Language': 'en-US,en;q=0.9',
'Accept-Encoding': 'gzip, deflate, br',
'Upgrade-Insecure-Requests': '1',
'Sec-Fetch-Site': 'cross-site',
'Sec-Fetch-Mode': 'navigate',
'Sec-Fetch-Dest': 'iframe',
};

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
// *** AANGEPAST: Gebruik de uitgebreide headers ***
headers: {
...COMMON_HEADERS,
'Referer': previousUrl || initialTarget,
}
});
if (!response.ok) break;

const html = await response.text();
const m3u8Url = extractM3u8Url(html);

if (m3u8Url) {
return { masterUrl: m3u8Url, sourceDomain: domain };
}

let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
if (nextIframeSrc) {
previousUrl = currentUrl;
currentUrl = new URL(nextIframeSrc, currentUrl).href;
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

const streamSource = await getVidSrcStream(type, imdbId, season, episode);

if (streamSource) {
const stream = {
url: streamSource.masterUrl,
title: streamSource.sourceDomain
};
return Promise.resolve({ streams: [stream] });
}

return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
