const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const url = require('url');

// --- DIAGNOSE FUNCTIE ---
async function getFinalHtml(imdbId) {
    console.log(`[DIAGNOSE] Starten voor IMDb ID: ${imdbId}`);
    const targetUrl = `https://vsrc.su/embed/movie/${imdbId}`;
    const sourceDomain = 'vsrc.su';
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    };

    let currentUrl = targetUrl;
    let previousUrl = null;
    let cookies = null;
    let lastFetchedHtml = 'Nog geen HTML opgehaald.';
    
    try {
        for (let step = 1; step <= 5; step++) {
            console.log(`[DIAGNOSE] Stap ${step}: Fetchen van ${currentUrl}`);
            const finalHeaders = { ...headers, 'Referer': previousUrl || `https://${sourceDomain}/` };
            if (cookies) finalHeaders['Cookie'] = cookies;
            delete finalHeaders['host'];

            const response = await fetch(currentUrl, { headers: finalHeaders, signal: AbortSignal.timeout(15000) });
            const setCookieHeader = response.headers.get('set-cookie');
            if (setCookieHeader) cookies = setCookieHeader;

            if (!response.ok) {
                lastFetchedHtml = `Fetch mislukt voor ${currentUrl} met status ${response.status}`;
                console.log(`[DIAGNOSE] ${lastFetchedHtml}`);
                break;
            }
            
            const html = await response.text();
            lastFetchedHtml = html;

            const staticIframeRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/;
            const jsIframeRegex = /(?:src|source)\s*:\s*["']([^"']+)["']/g;
            
            let nextIframeSrc = null;
            const staticMatch = html.match(staticIframeRegex);
            if(staticMatch) {
                nextIframeSrc = staticMatch[1];
            } else {
                 let jsMatch;
                 while ((jsMatch = jsIframeRegex.exec(html)) !== null) {
                    const nextUrl = jsMatch[1];
                    if (nextUrl && nextUrl.startsWith('/')) {
                        const path = nextUrl.split('?')[0].split('#')[0];
                        if (!path.endsWith('.js')) {
                            nextIframeSrc = nextUrl;
                            break;
                        }
                    }
                }
            }

            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
            } else {
                console.log('[DIAGNOSE] Geen iframes meer gevonden. Dit is de laatste pagina.');
                break;
            }
        }
        return lastFetchedHtml;
    } catch (error) {
        console.error(`[DIAGNOSE ERROR] Fout tijdens keten:`, error.message);
        return `Fout opgetreden: ${error.message}\n\nLaatst opgehaalde HTML:\n\n${lastFetchedHtml}`;
    }
}


// --- STREMIO ADDON LOGICA ---
const manifest = {
    "id": "community.nepflix.ries.diag",
    "version": "2.0.0",
    "name": "Nepflix (Diagnose Modus)",
    "description": "HLS streams van VidSrc",
    "icon": "/icon.png", // Toegevoegd voor volledigheid
    "catalogs": [],      // DEZE REGEL WAS DE OORZAAK VAN DE CRASH
    "resources": ["stream"],
    "types": ["movie", "series"],
    "idPrefixes": ["tt"]
};
const builder = new addonBuilder(manifest);
builder.defineStreamHandler(async ({ type, id }) => {
    return Promise.resolve({ streams: [] });
});
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);


// --- HOOFD ROUTER ---
module.exports = async (req, res) => {
    const parsedUrl = url.parse(req.url, true);

    if (parsedUrl.pathname.startsWith('/api/gethtml')) {
        const imdbId = parsedUrl.query.id;
        if (!imdbId || !imdbId.startsWith('tt')) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'text/plain');
            return res.end('Geef een geldige IMDb ID op in de query string, bv: /api/gethtml?id=tt0114369');
        }

        const finalHtml = await getFinalHtml(imdbId);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end(finalHtml);
    }

    router(req, res, () => {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ err: 'Not Found. Gebruik /api/gethtml?id=tt... voor diagnose.' }));
    });
};