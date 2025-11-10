// Dit is een debug-bestand. Het volgt de iframe-keten en retourneert de HTML van de LAATSTE pagina.

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
    const visitedUrls = new Set();
    
    console.log(`[DEBUG] Starting chain for ${targetUrl}`);
    let currentUrl = targetUrl;
    let previousUrl = null;
    const initialReferer = `https://${sourceDomain}/`;
    let cookies = null;
    let lastFetchedHtml = 'No HTML was fetched.'; // Om de laatste HTML op te slaan

    try {
        for (let step = 1; step <= MAX_REDIRECTS; step++) {
            if (visitedUrls.has(currentUrl)) {
                console.log(`[DEBUG] URL already visited, breaking loop: ${currentUrl}`);
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
            }

            if (!response.ok) {
                lastFetchedHtml = `Fetch failed for ${currentUrl} with status ${response.status}`;
                console.log(`[DEBUG] ${lastFetchedHtml}`);
                break;
            }
            
            const html = await response.text();
            lastFetchedHtml = html; // Sla de succesvol opgehaalde HTML op

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
                        const path = url.split('?')[0].split('#')[0];
                        if (!path.endsWith('.js')) {
                            nextIframeSrc = url;
                            break;
                        }
                    }
                }
            }

            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
                console.log(`[DEBUG] Found next iframe, redirecting to: ${currentUrl}`);
            } else {
                console.log('[DEBUG] No more iframes found. This is the final page.');
                break;
            }
        }
        
        // Stuur altijd de laatst opgehaalde HTML terug.
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.status(200).send(lastFetchedHtml);

    } catch (error) {
        console.error(`[DEBUG ERROR] Error during fetch chain for ${targetUrl}:`, error.message);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.status(500).send(`An error occurred: ${error.message}\n\nLast fetched HTML was:\n\n${lastFetchedHtml}`);
    }
};