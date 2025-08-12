const fetch = require('node-fetch');

// Exporteer de kernlogica zodat deze direct kan worden aangeroepen
async function executeProxyFetch(targetUrl, headers) {
    console.log(`[PROXY FN] Fetching URL: ${targetUrl}`);
    try {
        const response = await fetch(targetUrl, {
            headers: headers,
            signal: AbortSignal.timeout(15000) // 15 seconden timeout
        });

        const body = await response.text();
        
        console.log(`[PROXY FN] Response from ${targetUrl} - Status: ${response.status}`);
        if (!response.ok || !body.includes('m3u8')) {
            console.log(`[PROXY FN] Response body (truncated): ${body.substring(0, 500)}...`);
        }

        // Retourneer een gestandaardiseerd object voor de addon
        return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            text: () => Promise.resolve(body)
        };

    } catch (error) {
        console.error(`[PROXY FN ERROR] Fout bij fetchen van ${targetUrl}:`, error.message);
        // Gooi de error door zodat de aanroepende functie het kan afhandelen
        throw error;
    }
}

// De Vercel Serverless functie blijft bestaan voor het geval er een directe aanroep nodig is
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { targetUrl, headers } = req.body;
    if (!targetUrl) {
        return res.status(400).json({ error: 'Bad Request: targetUrl is required' });
    }

    try {
        const result = await executeProxyFetch(targetUrl, headers);
        // De body is al een string, dus we hoeven niet opnieuw .text() te callen
        const bodyText = await result.text();
        
        res.status(200).json({
            status: result.status,
            statusText: result.statusText,
            body: bodyText
        });
    } catch (error) {
        res.status(502).json({
            error: 'Proxy fetch failed',
            details: error.message
        });
    }
};

// Exporteer de functie ook los
module.exports.executeProxyFetch = executeProxyFetch;