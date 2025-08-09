const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

// --- DYNAMISCHE HOST & ICOON URL ---
const host = process.env.VERCEL_URL || 'http://127.0.0.1:3000';
const iconUrl = host.startsWith('http') ? `${host}/icon.png` : `https://${host}/icon.png`;

// --- MANIFEST ---
const manifest = {
    "id": "community.nepflix.ries",
    "version": "1.1.0",
    "name": "Nepflix",
    "description": "HLS streams van VidSrc",
    "icon": iconUrl,
    "catalogs": [],
    "resources": ["stream"],
    "types": ["movie", "series"],
    "idPrefixes": ["tt"]
};

const VIDSRC_DOMAINS = ["vidsrc.xyz", "vidsrc.in", "vidsrc.io", "vidsrc.me", "vidsrc.net", "vidsrc.pm", "vidsrc.vc", "vidsrc.to", "vidsrc.icu"];
const MAX_REDIRECTS = 5; // Limiet voor de diepe zoektocht in Fase 2
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';
const UNAVAILABLE_TEXT = "This media is unavailable at the moment.";

function extractM3u8Url(html) { const m = html.match(/(https?:\/\/[^\s'"]+?\.m3u8[^\s'"]*)/); return m ? m[1] : null; }
function findJsIframeSrc(html) { const r=/(?:src:\s*|\.src\s*=\s*)["']([^"']+)["']/g; let m; while((m=r.exec(html))!==null){const u=m[1]; if(u){const p=u.split('?')[0].split('#')[0]; if(!p.endsWith('.js'))return u;}} return null; }
function findHtmlIframeSrc(html) { const m = html.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/); return m ? m[1] : null; }

// FASE 2: Volgt de iframes diep om de m3u8 te vinden
async function deepSearchForM3u8(initialIframeSrc, refererUrl, sourceDomain) {
    let currentUrl = new URL(initialIframeSrc, refererUrl).href;
    let previousUrl = refererUrl;

    for (let i = 0; i < MAX_REDIRECTS; i++) {
        try {
            const response = await fetch(currentUrl, { headers: { 'Referer': previousUrl, 'User-Agent': FAKE_USER_AGENT } });
            if (!response.ok) break;

            const html = await response.text();
            const m3u8Url = extractM3u8Url(html);
            if (m3u8Url) {
                console.log(`Fase 2 Succes: m3u8 gevonden op ${sourceDomain}`);
                return { url: m3u8Url, title: `${sourceDomain} (adaptive)` };
            }

            const nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            if (nextIframeSrc) {
                previousUrl = currentUrl;
                currentUrl = new URL(nextIframeSrc, currentUrl).href;
            } else {
                break; // Einde van de keten
            }
        } catch (error) {
            console.error(`Fase 2 Fout tijdens diepe zoektocht op ${sourceDomain}:`, error.message);
            break;
        }
    }
    return null;
}

// FASE 1: Gestaggerde race om een valide startpagina te vinden
async function findStream(type, imdbId, season, episode) {
    const phase1Controller = new AbortController();
    const shuffledDomains = [...VIDSRC_DOMAINS].sort(() => 0.5 - Math.random());

    for (const [index, domain] of shuffledDomains.entries()) {
        // Stop onmiddellijk als een andere poging al een resultaat heeft gevonden
        if (phase1Controller.signal.aborted) {
            console.log("Fase 1 geannuleerd, een winnaar is al gevonden.");
            break;
        }

        // Voeg 1s vertraging toe voor elke poging na de eerste
        if (index > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            // Controleer opnieuw na het wachten
            if (phase1Controller.signal.aborted) {
                console.log("Fase 1 geannuleerd tijdens wachten.");
                break;
            }
        }

        console.log(`Fase 1: Poging op domein ${domain}...`);
        try {
            const apiType = type === 'series' ? 'tv' : 'movie';
            const initialUrl = `https://${domain}/embed/${apiType}/${imdbId}${type === 'series' ? `/${season}-${episode}` : ''}`;
            
            const response = await fetch(initialUrl, {
                signal: phase1Controller.signal, // Koppel de controller
                headers: { 'User-Agent': FAKE_USER_AGENT }
            });

            if (!response.ok) continue; // Probeer volgende domein

            const html = await response.text();

            // Definitieve faal-conditie
            if (html.includes(UNAVAILABLE_TEXT)) {
                console.log(`Definitieve Fout gevonden op ${domain}: "${UNAVAILABLE_TEXT}". Stoppen met zoeken.`);
                phase1Controller.abort(); // Annuleer alle andere pogingen
                return null; // Stop de hele zoektocht
            }
            
            // Succes-conditie
            const nextIframeSrc = findHtmlIframeSrc(html) || findJsIframeSrc(html);
            if (nextIframeSrc) {
                console.log(`Fase 1 Gewonnen door ${domain}! Start Fase 2...`);
                phase1Controller.abort(); // Annuleer alle andere pogingen
                // Start de diepe zoektocht en geef het resultaat direct terug
                return await deepSearchForM3u8(nextIframeSrc, initialUrl, domain);
            }

        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error(`Fase 1 Fout op ${domain}:`, error.message);
            }
        }
    }

    return null; // Geen enkel domein gaf een valide resultaat
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    if (!imdbId) { return Promise.resolve({ streams: [] }); }

    const stream = await findStream(type, imdbId, season, episode);

    if (stream) {
        return Promise.resolve({ streams: [stream] });
    }

    return Promise.resolve({ streams: [] });
});

module.exports = builder.getInterface();
