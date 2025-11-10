// --- HELPER FUNCTIES ---

function extractVidsrcFilename(htmlContent) {
    const regex = /atob\s*\(\s*['"]([^'"]+)['"]\s*\)/;
    const match = htmlContent.match(regex);
    if (match && match[1]) {
        try {
            const decodedString = atob(match[1]);
            const pathParts = decodedString.split('/');
            return pathParts[pathParts.length - 1];
        } catch (e) {
            console.error("Fout bij decoderen (filename):", e.message);
            return null;
        }
    }
    return null;
}

function extractM3u8Url(htmlContent) {
    const regex = /(?:file|source)\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/;
    const match = htmlContent.match(regex);
    return match ? match[1] : htmlContent.match(/(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/)?.[0] || null;
}

function extractEncodedM3u8Url(htmlContent) {
    const regex = /atob\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while ((match = regex.exec(htmlContent)) !== null) {
        try {
            const decodedString = atob(match[1]);
            if (decodedString.includes('.m3u8')) {
                return decodedString;
            }
        } catch (e) { /* Negeer */ }
    }
    return null;
}

/**
 * Zoekt naar een obfuscated/packed JavaScript blok (eval) en zoekt daarbinnen
 * naar een base64-gecodeerde string die de M3U8-link bevat.
 * @param {string} htmlContent De volledige HTML om te doorzoeken.
 * @returns {string|null} De gevonden en gedecodeerde M3U8 URL of null.
 */
function extractFromPackedJs(htmlContent) {
    // GECORRIGEERDE REGEX: Deze regex zoekt correct naar het 'eval(...)' blok.
    const packedRegex = /eval\(function\(p,a,c,k,e,d\)\{.*?\}\)/s;
    const packedMatch = htmlContent.match(packedRegex);

    if (packedMatch && packedMatch[0]) {
        console.log('[RESOLVER] GEPACKT JS-BLOK GEVONDEN. AAN HET ZOEKEN...');
        const scriptBlock = packedMatch[0];
        
        const base64Regex = /atob\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        let match;
        while ((match = base64Regex.exec(scriptBlock)) !== null) {
            try {
                const decodedString = atob(match[1]);
                if (decodedString.includes('.m3u8')) {
                    console.log('[RESOLVER] SUCCES! M3U8 gevonden in gepakt blok.');
                    return decodedString;
                }
            } catch (e) { /* Negeer decodeerfouten */ }
        }
    }
    return null;
}


function findJsIframeSrc(html) {
    const combinedRegex = /(?:src|source)\s*:\s*["']([^"']+)["']/g;
    let match;
    while ((match = combinedRegex.exec(html)) !== null) {
        const url = match[1];
        if (url && url.startsWith('/')) {
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

    const MAX_REDIRECTS = 5;
    const UNAVAILABLE_TEXT = 'This media is unavailable at the moment.';
    const visitedUrls = new Set();

    console.log(`[RESOLVER] Starting chain for ${targetUrl}`);
    let currentUrl = targetUrl;
    let previousUrl = null;
    const initialReferer = `https://${sourceDomain}/`;
    let foundFilename = null;
    let cookies = null;

    try {
        for (let step = 1; step <= MAX_REDIRECTS; step++) {
            if (visitedUrls.has(currentUrl)) {
                break;
            }
            visitedUrls.add(currentUrl);

            const finalHeaders = { ...headers, 'Referer': previousUrl || initialReferer };
            delete finalHeaders['host'];
            if (cookies) finalHeaders['Cookie'] = cookies;

            const response = await fetch(currentUrl, { headers: finalHeaders, signal: AbortSignal.timeout(15000) });
            const setCookieHeader = response.headers.get('set-cookie');
            if (setCookieHeader) {
                cookies = setCookieHeader;
                console.log('[RESOLVER] Cookie captured.');
            }

            if (!response.ok) {
                console.log(`[RESOLVER] Fetch failed for ${currentUrl} with status ${response.status}`);
                return res.status(404).json({ error: `Fetch failed with status ${response.status}` });
            }

            const html = await response.text();

            if (step === 1 && html.includes(UNAVAILABLE_TEXT)) {
                return res.status(499).json({ error: 'Media unavailable' });
            }

            if (!foundFilename) {
                foundFilename = extractVidsrcFilename(html);
                if (foundFilename) console.log(`[RESOLVER] Found filename: ${foundFilename}`);
            }

            // Probeer alle methodes in volgorde van simpel naar complex
            let m3u8Url = extractM3u8Url(html) || extractEncodedM3u8Url(html) || extractFromPackedJs(html);

            if (m3u8Url) {
                console.log(`[RESOLVER] Success, found M3U8: ${m3u8Url}`);
                return res.status(200).json({ masterUrl: m3u8Url, sourceDomain: sourceDomain, filename: foundFilename });
            }

            const nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
                console.log(`[RESOLVER] Found next iframe, redirecting to: ${currentUrl}`);
            } else {
                console.log('[RESOLVER] No more iframes or M3U8 found.');
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