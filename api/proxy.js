// /api/proxy.js

const fetch = require('node-fetch');

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

    // De body van het POST-verzoek moet de doel-URL en headers bevatten
    const { targetUrl, headers } = req.body;

    if (!targetUrl) {
        return res.status(400).json({ error: 'Bad Request: targetUrl is required' });
    }

    console.log(`[PROXY] Fetching URL: ${targetUrl}`); // TOEGEVOEGD VOOR DEBUGGING

    try {
        // Voer het daadwerkelijke fetch-verzoek uit namens de addon
        const response = await fetch(targetUrl, {
            headers: headers,
            // Vercel serverless functies hebben een timeout, we respecteren een redelijke limiet
            signal: AbortSignal.timeout(15000)
        });

        // Haal de body (HTML-tekst) op
        const body = await response.text();
        
        // TOEGEVOEGD VOOR DEBUGGING: Log de status en een deel van de response body
        console.log(`[PROXY] Response from ${targetUrl} - Status: ${response.status}`);
        if (!response.ok || !body.includes('m3u8')) {
            // Log de body als de status niet ok is, of als het geen m3u8 bevat, om te zien wat we terugkrijgen (bv. een CAPTCHA)
            console.log(`[PROXY] Response body (truncated): ${body.substring(0, 500)}...`);
        }


        // Stuur de status en de body van de doelwebsite terug naar de addon
        res.status(200).json({
            status: response.status,
            statusText: response.statusText,
            body: body
        });

    } catch (error) {
        // Als de fetch mislukt, stuur een serverfout terug
        console.error(`[PROXY ERROR] Fout bij fetchen van ${targetUrl}:`, error.message);
        res.status(502).json({
            error: 'Proxy fetch failed',
            details: error.message
        });
    }
};