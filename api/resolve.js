// --- HELPER FUNCTIES ---

/**
* Zoekt in een HTML-string naar een Base64-gecodeerde bestandsnaam binnen een atob() functie,
* decodeert deze en geeft alleen de bestandsnaam terug (zonder het pad).
* @param {string} htmlContent De volledige HTML-broncode van de pagina om te doorzoeken.
* @returns {string|null} De opgeschoonde bestandsnaam (bijv. 'video.mp4') als deze wordt gevonden, anders null.
*/
function extractVidsrcFilename(htmlContent) {
    const regex = /atob\s*\(\s*['"]([^'"]+)['"]\s*\)/;
    const match = htmlContent.match(regex);

    if (match && match[1]) {
        const base64String = match[1];
        try {
            const decodedString = atob(base64String);
            const pathParts = decodedString.split('/');
            return pathParts[pathParts.length - 1];
        } catch (e) {
            console.error("Fout bij het decoderen van de Base64-string (filename):", e.message);
            return null;
        }
    }
    return null;
}

/**
 * Extraheert een M3U8 URL uit HTML-content (platte tekst).
 * @param {string} htmlContent De HTML om te doorzoeken.
 * @returns {string|null} De gevonden M3U8 URL of null.
 */
function extractM3u8Url(htmlContent) {
    const regex = /(?:file|source)\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/;
    const match = htmlContent.match(regex);
    return match ? match[1] : htmlContent.match(/(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/)?.[0] || null;
}

/**
 * NIEUWE FUNCTIE
 * Zoekt naar base64-gecodeerde strings in atob() functies, decodeert ze
 * en retourneert de eerste die een .m3u8 link blijkt te zijn.
 * @param {string} htmlContent De HTML om te doorzoeken.
 * @returns {string|null} De gevonden en gedecodeerde M3U8 URL of null.
 */
function extractEncodedM3u8Url(htmlContent) {
    const regex = /atob\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while ((match = regex.exec(htmlContent)) !== null) {
        const base64String = match[1];
        try {
            const decodedString = atob(base64String);
            // Controleer of de gedecodeerde string een M3U8 URL is
            if (decodedString.includes('.m3u8')) {
                console.log('[RESOLVER] Decoded string is a valid M3U8 URL!');
                return decodedString;
            }
        } catch (e) {
            // Negeer decodeerfouten, het was waarschijnlijk een andere base64 string
        }
    }
    return null;
}


function findJsIframeSrc(html) {
    const combinedRegex = /(?:src|source)\s*:\s*["']([^"']+)["']/g;
    let match;
    while ((match = combinedRegex.exec(html)) !== null) {
        const url = match[1];
        if (url) {
            const path = url.split('?')[0].split('#')[0];
            if (!path.endsWith('.js') && url.startsWith('/')) return url;
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
                console.log(`[RESOLVER] URL already visited, breaking loop: ${currentUrl}`);
                break;
            }
            visitedUrls.add(currentUrl);

            const finalHeaders = { ...headers, 'Referer': previousUrl || initialReferer };
            delete finalHeaders['host'];

            if (cookies) {
                finalHeaders['Cookie'] = cookies;
            }

            const response = await fetch(currentUrl, {
                headers: finalHeaders,
                signal: AbortSignal.timeout(15000)
            });
            
            const setCookieHeader = response.headers.get('set-cookie');
            if (setCookieHeader) {
                cookies = setCookieHeader;
                console.log('[RESOLVER] Cookie captured.');
            }

            if (!response.ok) {
                console.log(`[RESOLVER] Fetch failed for ${currentUrl} with status ${response.status}`);
                return res.status(404).json({ error: `Fetch failed for ${currentUrl} with status ${response.status}` });
            }

            const html = await response.text();

            if (step === 1 && html.includes(UNAVAILABLE_TEXT)) {
                console.log(`[RESOLVER] Media is unavailable. Aborting.`);
                return res.status(499).json({ error: 'Media unavailable' });
            }

            if (!foundFilename) {
                foundFilename = extractVidsrcFilename(html);
                if (foundFilename) {
                    console.log(`[RESOLVER] Found filename: ${foundFilename}`);
                }
            }

            // AANGEPASTE LOGICA: Probeer beide extractiemethodes
            let m3u8Url = extractM3u8Url(html) || extractEncodedM3u8Url(html);

            if (m3u8Url) {
                console.log(`[RESOLVER] Success, found M3U8: ${m3u8Url}`);
                return res.status(200).json({
                    masterUrl: m3u8Url,
                    sourceDomain: sourceDomain,
                    filename: foundFilename
                });
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