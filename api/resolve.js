// Functie om de bestandsnaam te vinden
function extractVidsrcFilename(htmlContent) {
    const regex = /atob\s*\(\s*['"]([^'"]+)['"]\s*\)/;
    const match = htmlContent.match(regex);
    if (match && match[1]) {
        try {
            const decodedString = atob(match[1]);
            const pathParts = decodedString.split('/');
            return pathParts[pathParts.length - 1];
        } catch (e) { return null; }
    }
    return null;
}

// Functie om de gecodeerde string uit de verborgen div te halen
function extractEncodedDivContent(html) {
    const regex = /<div id="([^"]+)" style="display:none;">([^<]+)<\/div>/;
    const match = html.match(regex);
    if (match && match[1] && match[2]) {
        if (html.includes(`file: ${match[1]}`)) {
            console.log("[RESOLVER] Gecodeerde div gevonden!");
            return match[2];
        }
    }
    return null;
}

/**
 * Dit is de correcte decodeerfunctie, gebaseerd op de analyse van het externe script.
 * Het voert een reeks van atob-operaties uit.
 * @param {string} encoded - De gecodeerde string uit de verborgen div.
 * @returns {string} De gedecodeerde M3U8 URL.
 */
function decodeSource(encoded) {
    try {
        let a = encoded;
        // Het script past meerdere rondes van atob toe, die we hier nabootsen.
        // Elke ronde verwijdert 2 prefix-karakters. We blijven dit doen tot het een M3U8-link is.
        for (let i = 0; i < 5; i++) { // Maximaal 5 pogingen om een oneindige lus te voorkomen
            if (a.startsWith('//')) {
                a = atob(a.substring(2));
            } else {
                 a = atob(a);
            }
        }
        return a;
    } catch (e) {
        // Soms is de string na een paar rondes al klaar.
        // Als de laatste 'atob' mislukt, hebben we waarschijnlijk al de URL.
        if(encoded.includes('.m3u8')) return encoded; // Fallback
        
        console.error("Decodeerfout:", e.message);
        return null;
    }
}


module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { targetUrl, sourceDomain, headers } = req.body;
    if (!targetUrl || !sourceDomain || !headers) return res.status(400).json({ error: 'Bad Request' });

    let currentUrl = targetUrl;
    let previousUrl = null;
    let cookies = null;
    let foundFilename = null;

    try {
        for (let step = 1; step <= 5; step++) {
            const finalHeaders = { ...headers, 'Referer': previousUrl || `https://${sourceDomain}/` };
            if (cookies) finalHeaders['Cookie'] = cookies;
            delete finalHeaders['host'];

            const response = await fetch(currentUrl, { headers: finalHeaders, signal: AbortSignal.timeout(10000) });
            const setCookieHeader = response.headers.get('set-cookie');
            if (setCookieHeader) cookies = setCookieHeader;

            if (!response.ok) break;
            const html = await response.text();
            
            if (step === 1 && html.includes('This media is unavailable')) {
                 return res.status(499).json({ error: 'Media unavailable' });
            }

            if (!foundFilename) foundFilename = extractVidsrcFilename(html);

            const encodedContent = extractEncodedDivContent(html);
            if (encodedContent) {
                const decodedUrl = decodeSource(encodedContent);
                // De URL kan relatief zijn (//... .m3u8), dus we maken hem absoluut.
                const m3u8Url = decodedUrl.startsWith('//') ? 'https:' + decodedUrl : decodedUrl;

                if (m3u8Url && m3u8Url.includes('.m3u8')) {
                    console.log(`[RESOLVER] SUCCES! Gevonden M3U8: ${m3u8Url}`);
                    return res.status(200).json({ masterUrl: m3u8Url, sourceDomain: sourceDomain, filename: foundFilename });
                }
            }

            const iframeRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/;
            const iframeMatch = html.match(iframeRegex);
            if (iframeMatch && iframeMatch[1]) {
                previousUrl = currentUrl;
                currentUrl = new URL(iframeMatch[1], currentUrl).href;
            } else {
                break;
            }
        }
        console.log(`[RESOLVER] Ketting voltooid zonder resultaat voor ${targetUrl}`);
        return res.status(404).json({ error: 'M3U8 niet gevonden in keten' });
    } catch (error) {
        console.error(`[RESOLVER ERROR]`, error.message);
        return res.status(502).json({ error: 'Proxy fetch mislukt' });
    }
};