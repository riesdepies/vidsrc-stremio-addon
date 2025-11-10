// Functie om de M3U8 uit de gecodeerde div te halen
function decodeSource(encoded) {
    let a = encoded.split('').reverse().join('');
    let b = atob(a);
    let c = b.substring(2);
    let d = atob(c);
    let e = d.substring(2);
    let f = atob(e);
    let g = f.substring(2);
    let h = atob(g);
    let i = h.substring(2);
    return atob(i);
}

// Functie om de gecodeerde string uit de HTML te vissen
function extractEncodedDivContent(html) {
    const regex = /<div id="([^"]+)" style="display:none;">([^<]+)<\/div>/;
    const match = html.match(regex);
    if (match && match[1] && match[2]) {
        // Controleer of de player-initialisatie deze ID gebruikt
        if (html.includes(`file: ${match[1]}`)) {
            console.log("[RESOLVER] Gecodeerde div en player-gebruik gevonden!");
            return match[2]; // Return de gecodeerde content
        }
    }
    return null;
}

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
        return res.status(400).json({ error: 'Bad Request' });
    }

    let currentUrl = targetUrl;
    let previousUrl = null;
    let cookies = null;
    let foundFilename = null;

    try {
        for (let step = 1; step <= 5; step++) {
            const finalHeaders = { ...headers, 'Referer': previousUrl || `https://${sourceDomain}/` };
            if (cookies) finalHeaders['Cookie'] = cookies;
            delete finalHeaders['host'];

            const response = await fetch(currentUrl, { headers: finalHeaders, signal: AbortSignal.timeout(15000) });
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
                const m3u8Url = decodeSource(encodedContent);
                if (m3u8Url && m3u8Url.includes('.m3u8')) {
                    console.log(`[RESOLVER] SUCCES! Gevonden M3U8: ${m3u8Url}`);
                    return res.status(200).json({ masterUrl: m3u8Url, sourceDomain: sourceDomain, filename: foundFilename });
                }
            }

            const staticIframeRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/;
            const jsIframeRegex = /(?:src|source)\s*:\s*["']([^"']+)["']/g;
            
            let nextIframeSrc = null;
            const staticMatch = html.match(staticIframeRegex);
            if(staticMatch) {
                nextIframeSrc = staticMatch[1];
            } else {
                 let jsMatch;
                 while ((jsMatch = jsIframeRegex.exec(html)) !== null) {
                    const url = jsMatch[1];
                    if (url && url.startsWith('/')) {
                        if (!url.split('?')[0].split('#')[0].endsWith('.js')) {
                            nextIframeSrc = url;
                            break;
                        }
                    }
                }
            }
            
            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
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
