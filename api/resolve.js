const fetch = require('node-fetch');

// --- CONSTANTEN ---
const MAX_REDIRECTS = 5;
const UNAVAILABLE_TEXT = 'This media is unavailable at the moment.';

// --- HELPER FUNCTIES ---
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
            const path = url.split('?')[0].split('#[')[0];
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

// --- MAIN SERVERLESS FUNCTIE ---
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
    if (!initialTargetUrl || !headers) {
        return res.status(400).json({ error: 'Bad Request: initialTargetUrl and headers are required' });
    }

    console.log(`[RESOLVER] Starting chain for ${initialTargetUrl}`);
    
    let currentUrl = initialTargetUrl;
    let previousUrl = null;
    const initialReferer = new URL(initialTargetUrl).origin + '/';

    for (let step = 1; step <= MAX_REDIRECTS; step++) {
        try {
            // Realistische vertraging tussen requests
            if (step > 1) {
                await new Promise(resolve => setTimeout(resolve, Math.random() * 350 + 150));
            }
            
            const response = await fetch(currentUrl, {
                headers: { ...headers, 'Referer': previousUrl || initialReferer },
                signal: AbortSignal.timeout(15000)
            });

            if (!response.ok) {
                console.log(`[RESOLVER] Step ${step}: Received non-OK status ${response.status} for ${currentUrl}`);
                break; // Stop bij een foutstatus
            }

            const html = await response.text();

            if (step === 1 && html.includes(UNAVAILABLE_TEXT)) {
                console.log(`[RESOLVER] Media is unavailable.`);
                return res.status(200).json({ masterUrl: null, unavailable: true });
            }

            const m3u8Url = extractM3u8Url(html);
            if (m3u8Url) {
                console.log(`[RESOLVER] Success, found m3u8: ${m3u8Url}`);
                return res.status(200).json({ masterUrl: m3u8Url, unavailable: false });
            }

            const nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
            } else {
                console.log(`[RESOLVER] Step ${step}: No m3u8 or next iframe found. Ending chain.`);
                break;
            }
        } catch (error) {
            console.error(`[RESOLVER ERROR] Fout bij fetchen van ${currentUrl}:`, error.message);
            return res.status(502).json({ error: 'Fetch failed during chain', details: error.message });
        }
    }

    // Als de lus eindigt zonder resultaat
    return res.status(200).json({ masterUrl: null, unavailable: false });
};