const { VM } = require('vm2');

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

// Functie om de verborgen data en het decoderingsscript te vinden
function findEncodedDataAndScript(html) {
    const dataRegex = /<div id="([^"]+)" style="display:none;">([^<]+)<\/div>/;
    const dataMatch = html.match(dataRegex);

    if (dataMatch && dataMatch[1] && dataMatch[2]) {
        const divId = dataMatch[1];
        const encodedContent = dataMatch[2];

        // Zoek nu het script dat deze divId gebruikt
        const scriptRegex = new RegExp(`<script src="([^"]+)"><\\/script>`);
        const scriptMatch = html.match(scriptRegex);

        if (scriptMatch && scriptMatch[1] && html.includes(`file: ${divId}`)) {
            console.log("[RESOLVER] Gecodeerde data en decoderingsscript gevonden.");
            return {
                divId: divId,
                encodedContent: encodedContent,
                scriptUrl: scriptMatch[1]
            };
        }
    }
    return null;
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

            const foundData = findEncodedDataAndScript(html);
            if (foundData) {
                console.log(`[RESOLVER] Decoderingsscript ophalen van: ${foundData.scriptUrl}`);
                const scriptFullUrl = new URL(foundData.scriptUrl, currentUrl).href;
                const scriptResponse = await fetch(scriptFullUrl, { headers: { 'Referer': currentUrl } });
                if (scriptResponse.ok) {
                    const decoderScript = await scriptResponse.text();
                    console.log("[RESOLVER] Decoderingsscript succesvol opgehaald.");

                    // Creëer een veilige sandbox om het script uit te voeren
                    const vm = new VM({
                        timeout: 1000,
                        sandbox: {
                            // Definieer de `IhWrImMIGL` variabele in de sandbox
                            [foundData.divId]: foundData.encodedContent,
                            m3u8UrlResult: null // Hier slaan we het resultaat op
                        }
                    });

                    // Pas het script aan om het resultaat op te slaan
                    const modifiedScript = decoderScript.replace(/file:\s*([a-zA-Z0-9_]+)/, 'm3u8UrlResult = $1');
                    
                    vm.run(modifiedScript);
                    
                    const m3u8Url = vm.getGlobal('m3u8UrlResult');
                    
                    if (m3u8Url && typeof m3u8Url === 'string' && m3u8Url.includes('.m3u8')) {
                        console.log(`[RESOLVER] SUCCES! Gevonden M3U8: ${m3u8Url}`);
                        return res.status(200).json({ masterUrl: m3u8Url, sourceDomain: sourceDomain, filename: foundFilename });
                    }
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