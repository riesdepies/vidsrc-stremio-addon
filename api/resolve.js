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
            console.error("Fout bij het decoderen van de Base64-string:", e.message);
            return null;
        }
    }
    return null;
}

/**
 * Extraheert een M3U8 URL uit HTML-content.
 * Zoekt zowel naar directe links als naar links binnen JavaScript-variabelen zoals 'file:' of 'source:'.
 * @param {string} htmlContent De HTML om te doorzoeken.
 * @returns {string|null} De gevonden M3U8 URL of null.
 */
function extractM3u8Url(htmlContent) {
    const regex = /(?:file|source)\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/;
    const match = htmlContent.match(regex);
    return match ? match[1] : htmlContent.match(/(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/)?.[0] || null;
}


function findJsIframeSrc(html) {
    // Deze regex vindt bronnen die dynamisch in JS worden ingesteld, zoals in de cloudnestra pagina.
    const combinedRegex = /(?:src|source)\s*:\s*["']([^"']+)["']/g;
    let match;
    while ((match = combinedRegex.exec(html)) !== null) {
        const url = match[1];
        if (url) {
            // Zorg ervoor dat we geen .js bestanden of andere ongewenste links pakken.
            // Een iframe src zal doorgaans geen extensie hebben of eindigen op .php/.html
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
    let cookies = null; // Variabele om cookies op te slaan

    try {
        for (let step = 1; step <= MAX_REDIRECTS; step++) {
            if (visitedUrls.has(currentUrl)) {
                console.log(`[RESOLVER] URL already visited, breaking loop: ${currentUrl}`);
                break;
            }
            visitedUrls.add(currentUrl);

            const finalHeaders = { ...headers, 'Referer': previousUrl || initialReferer };
            delete finalHeaders['host'];

            // Voeg de opgeslagen cookies toe aan de request header
            if (cookies) {
                finalHeaders['Cookie'] = cookies;
            }

            const response = await fetch(currentUrl, {
                headers: finalHeaders,
                signal: AbortSignal.timeout(15000)
            });
            
            // Sla de 'set-cookie' header op voor de volgende request
            const setCookieHeader = response.headers.get('set-cookie');
            if (setCookieHeader) {
                cookies = setCookieHeader;
                console.log('[RESOLVER] Cookie captured.');
            }

            if (!response.ok) {
                console.log(`[RESOLVER] Fetch failed for ${currentUrl} with status ${response.status}`);
                // Stop de loop als de status niet ok is (bijv. 404).
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

            const m3u8Url = extractM3u8Url(html);
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