const fetch = require('node-fetch');

const MAX_REDIRECTS = 5;
const UNAVAILABLE_TEXT = 'This media is unavailable at the moment.';
const visitedUrls = new Set(); // Houd bezochte URLs bij binnen deze ene instantie

// --- HELPER FUNCTIES (NU IN DE RESOLVER) ---
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
            if (!path.endsWith('.js')) return url;
        }
    }
    return null;
}

function findHtmlIframeSrc(html) {
    const staticRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/;
    const match = html.match(staticRegex);
    return match ? match[1] : null;
}


module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { targetUrl, sourceDomain, headers } = req.body;
    if (!targetUrl || !sourceDomain || !headers) {
        return res.status(400).json({ error: 'Bad Request: targetUrl, sourceDomain, and headers are required' });
    }

    console.log(`[RESOLVER] Starting chain for ${targetUrl}`);
    let currentUrl = targetUrl;
    let previousUrl = null;
    const initialReferer = `https://${sourceDomain}/`;

    try {
        for (let step = 1; step <= MAX_REDIRECTS; step++) {
            if (visitedUrls.has(currentUrl)) {
                 console.log(`[RESOLVER] URL already visited, breaking loop: ${currentUrl}`);
                 break;
            }
            visitedUrls.add(currentUrl);

            const finalHeaders = { ...headers, 'Referer': previousUrl || initialReferer };
            delete finalHeaders['host'];

            const response = await fetch(currentUrl, {
                headers: finalHeaders,
                signal: AbortSignal.timeout(15000)
            });

            if (!response.ok) {
                console.log(`[RESOLVER] Fetch failed for ${currentUrl} with status ${response.status}`);
                break;
            }
            
            const html = await response.text();

            if (step === 1 && html.includes(UNAVAILABLE_TEXT)) {
                console.log(`[RESOLVER] Media is unavailable. Aborting.`);
                return res.status(499).json({ error: 'Media unavailable' });
            }

            const m3u8Url = extractM3u8Url(html);
            if (m3u8Url) {
                console.log(`[RESOLVER] Success, found M3U8: ${m3u8Url}`);
                return res.status(200).json({ masterUrl: m3u8Url, sourceDomain: sourceDomain });
            }

            const nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
                 console.log(`[RESOLVER] Found next iframe, redirecting to: ${currentUrl}`);
            } else {
                console.log('[RESOLVER] No more iframes found.');
                break;
            }
        }
        
        console.log(`[RESOLVER] Chain finished without result for ${targetUrl}`);
        return res.status(404).json({ error: 'M3U8 not found in chain' });

    } catch (error) {
        console.error(`[RESOLVER ERROR] Error during fetch chain for ${targetUrl}:`, error.message);
        return res.status(502).json({ error: 'Proxy fetch failed', details: error.message });
    }
};