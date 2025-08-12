// /api/proxy.js

const fetch = require('node-fetch');

const MAX_REDIRECTS = 5;
const UNAVAILABLE_TEXT = 'This media is unavailable at the moment.';
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

// Helper functies
function extractM3u8Url(htmlContent) {
    const regex = /(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/;
    const match = htmlContent.match(regex);
    return match ? match[1] : null;
}

function findIframeSrc(html) {
    const staticRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/;
    let match = html.match(staticRegex);
    if (match) return match[1];

    const jsSrcRegex = /(?:src:\s*|\.src\s*=\s*)["']([^"']+)["']/g;
    while ((match = jsSrcRegex.exec(html)) !== null) {
        const url = match[1];
        if (url && !url.split('?')[0].endsWith('.js')) {
            return url;
        }
    }
    return null;
}

// Scrape functie die één domein probeert
async function searchDomain(domain, apiType, imdbId, season, episode, controller, visitedUrls) {
    let initialTarget = `https://${domain}/embed/${apiType}/${imdbId}`;
    if (apiType === 'tv' && season && episode) {
        initialTarget += `/${season}-${episode}`;
    }

    let currentUrl = initialTarget;
    let previousUrl = null;

    for (let step = 1; step <= MAX_REDIRECTS; step++) {
        if (controller.signal.aborted) return null;
        if (visitedUrls.has(currentUrl)) return null;
        visitedUrls.add(currentUrl);

        try {
            const response = await fetch(currentUrl, {
                signal: AbortSignal.timeout(8000), // Timeout per fetch
                headers: { ...COMMON_HEADERS, 'Referer': previousUrl || initialTarget }
            });
            if (!response.ok) break;

            const html = await response.text();
            if (step === 1 && html.includes(UNAVAILABLE_TEXT)) {
                 console.log(`[PROXY] Domein ${domain} meldt: Media onbeschikbaar.`);
                 return null;
            }
            
            const m3u8Url = extractM3u8Url(html);
            if (m3u8Url) {
                console.log(`[PROXY] GEVONDEN op ${domain}: ${m3u8Url}`);
                controller.abort(); // Annuleer andere zoekopdrachten
                return { masterUrl: m3u8Url, sourceDomain: domain };
            }

            let nextIframeSrc = findIframeSrc(html);
            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
            } else {
                break;
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                 console.error(`[PROXY] Fout bij verwerken domein ${domain} op URL ${currentUrl}:`, error.message);
            }
            break;
        }
    }
    return null;
}

// Hoofdfunctie van de proxy
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { type, imdbId, season, episode, domains } = req.body;
    if (!type || !imdbId || !domains) {
        return res.status(400).json({ error: 'Bad Request: type, imdbId, and domains are required' });
    }

    const apiType = type === 'series' ? 'tv' : 'movie';
    const controller = new AbortController();
    const visitedUrls = new Set();
    
    // Shuffle domains
    const shuffledDomains = [...domains];
    for (let i = shuffledDomains.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledDomains[i], shuffledDomains[j]] = [shuffledDomains[j], shuffledDomains[i]];
    }
    
    // Start parallelle zoekopdrachten
    const searchPromises = shuffledDomains.map(domain => 
        searchDomain(domain, apiType, imdbId, season, episode, controller, visitedUrls)
    );

    try {
        // Wacht tot één van de promises een resultaat geeft of tot ze allemaal falen
        const result = await Promise.any(searchPromises.filter(p => p !== null));
        
        if (result) {
            return res.status(200).json(result);
        } else {
            return res.status(404).json({ error: 'Stream not found' });
        }
    } catch (error) {
        // Promise.any gooit een AggregateError als alle promises falen
        console.log(`[PROXY] Geen enkele zoekopdracht was succesvol voor ${imdbId}.`);
        return res.status(404).json({ error: 'Stream not found', details: "All domains failed." });
    }
};