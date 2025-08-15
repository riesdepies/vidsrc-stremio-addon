const fetch = require('node-fetch');

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

    console.log(`[PROXY] Fetching URL: ${targetUrl}`);

    // --- HEADER OPSCHONING ---
    const finalHeaders = { ...headers };
    // Verwijder headers die door Vercel kunnen worden toegevoegd en de proxy verraden
    delete finalHeaders['x-forwarded-for'];
    delete finalHeaders['x-vercel-forwarded-for'];
    delete finalHeaders['x-vercel-id'];
    delete finalHeaders['x-real-ip'];
    delete finalHeaders['host']; // Laat node-fetch de Host header zelf correct instellen

    try {
        const response = await fetch(targetUrl, {
            headers: finalHeaders, // Gebruik de opgeschoonde headers
            signal: AbortSignal.timeout(15000)
        });
        const body = await response.text();
        console.log(`[PROXY] Response from ${targetUrl} - Status: ${response.status}`);
        if (!response.ok || !body.includes('m3u8')) {
            console.log(`[PROXY] Response body (truncated): ${body.substring(0, 500)}...`);
        }
        res.status(200).json({
            status: response.status,
            statusText: response.statusText,
            body: body
        });
    } catch (error) {
        console.error(`[PROXY ERROR] Fout bij fetchen van ${targetUrl}:`, error.message);
        res.status(502).json({
            error: 'Proxy fetch failed',
            details: error.message
        });
    }
};