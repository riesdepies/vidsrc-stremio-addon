// /api/proxy.js

const p = require('phin');

// Helper-functie om de JSON-body van een request te parsen
async function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                // Voorkom parsen van een lege body
                if (body) {
                    resolve(JSON.parse(body));
                } else {
                    resolve({});
                }
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
        // Parse de body van het POST-verzoek
        const { targetUrl, headers } = await parseJsonBody(req);

        if (!targetUrl) {
            return res.status(400).json({ error: 'Bad Request: targetUrl is required' });
        }

        // Voer het daadwerkelijke phin-verzoek uit namens de addon
        const response = await p({
            url: targetUrl,
            method: 'GET',
            headers: headers,
            timeout: 15000,
            followRedirects: true // <-- DE BELANGRIJKE TOEVOEGING
        });

        // phin's body is een Buffer, dus converteer naar string
        const body = response.body.toString('utf-8');

        // Stuur de status en de body van de doelwebsite terug naar de addon
        res.status(200).json({
            status: response.statusCode,
            statusText: response.statusMessage,
            body: body
        });

    } catch (error) {
        console.error(`[PROXY ERROR] Fout bij verwerken proxy request naar ${req.body ? req.body.targetUrl : 'onbekend'}:`, error.message);
        res.status(500).json({
            error: 'Proxy request failed',
            details: error.message
        });
    }
};