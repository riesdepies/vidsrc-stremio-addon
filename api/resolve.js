const fetch = require('node-fetch');

// --- CONSTANTEN ---
const MAX_REDIRECTS = 5;
const UNAVAILABLE_TEXT = 'This media is unavailable at the moment.';

// --- HELPER FUNCTIES (HIER GEPLAATST) ---
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


// --- HOOFDFUNCTIE ---
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { initialTargetUrl, headers } = req.body;
    if (!initialTargetUrl) {
        return res.status(400).json({ error: 'Bad Request: initialTargetUrl is required' });
    }
    
    const initialReferer = new URL(initialTargetUrl).origin + '/';
    let currentUrl = initialTargetUrl;
    let previousUrl = null;

    console.log(`[RESOLVER] Start resolving chain for: ${currentUrl}`);

    try {
        for (let step = 1; step <= MAX_REDIRECTS; step++) {
            const finalHeaders = { ...headers };
            delete finalHeaders['x-forwarded-for'];
            delete finalHeaders['x-vercel-forwarded-for'];
            delete finalHeaders['x-vercel-id'];
            delete finalHeaders['x-real-ip'];
            delete finalHeaders['host'];
            finalHeaders['Referer'] = previousUrl || initialReferer;

            const response = await fetch(currentUrl, {
                headers: finalHeaders,
                signal: AbortSignal.timeout(15000)
            });

            if (!response.ok) {
                console.log(`[RESOLVER] Chain broken at step ${step}: Received non-OK status ${response.status} for ${currentUrl}`);
                return res.status(200).json({ success: false, reason: 'http_error' });
            }

            const html = await response.text();

            if (step === 1 && html.includes(UNAVAILABLE_TEXT)) {
                console.log(`[RESOLVER] Media is unavailable.`);
                return res.status(200).json({ success: false, reason: 'unavailable' });
            }

            const m3u8Url = extractM3u8Url(html);
            if (m3u8Url) {
                console.log(`[RESOLVER] Success, found m3u8 URL: ${m3u8Url}`);
                return res.status(200).json({ success: true, masterUrl: m3u8Url });
            }

            let nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
            } else {
                console.log(`[RESOLVER] Chain broken at step ${step}: No m3u8 or next iframe found.`);
                return res.status(200).json({ success: false, reason: 'no_m3u8_found' });
            }
        }
        console.log('[RESOLVER] Reached max redirects without finding m3u8.');
        return res.status(200).json({ success: false, reason: 'max_redirects' });

    } catch (error) {
        console.error(`[RESOLVER ERROR] Fout bij fetchen van ${currentUrl}:`, error.message);
        res.status(502).json({
            error: 'Resolver fetch failed',
            details: error.message
        });
    }
};