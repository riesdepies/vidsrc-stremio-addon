// /api/proxy.js

const fetch = require('node-fetch');

// Helper-functie om de JSON-body van een request te parsen
async function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', (err) => {
            reject(err);
        });
    });
}

// Exporteer de serverless functie
module.exports = async (req, res) => {
    // Stel CORS headers in voor alle responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    // Behandel pre-flight OPTIONS requests
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    // Accepteer alleen POST requests
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // Parse de body van het POST-verzoek, inclusief de optionele cookie
        const { targetUrl, headers, cookie } = await parseJsonBody(req);

        if (!targetUrl) {
            return res.status(400).json({ error: 'Bad Request: targetUrl is required' });
        }
        
        const requestHeaders = { ...headers };
        if (cookie) {
            requestHeaders['Cookie'] = cookie;
        }

        // Voer het daadwerkelijke fetch-verzoek uit namens de addon
        const response = await fetch(targetUrl, {
            headers: requestHeaders,
            signal: AbortSignal.timeout(15000) 
        });

        const body = await response.text();
        // Vang de Set-Cookie headers op
        const setCookieHeader = response.headers.raw()['set-cookie'];

        // Stuur de status, body en cookies van de doelwebsite terug naar de addon
        res.status(200).json({
            status: response.status,
            statusText: response.statusText,
            body: body,
            setCookie: setCookieHeader || null
        });

    } catch (error) {
        console.error(`[PROXY ERROR] Fout bij verwerken proxy request:`, error.message);
        res.status(500).json({ 
            error: 'Proxy request failed', 
            details: error.message 
        });
    }
};
