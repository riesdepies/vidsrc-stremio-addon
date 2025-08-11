// /api/proxy.js
const fetch = require('node-fetch');

module.exports = async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        res.status(400).json({ error: 'URL parameter is missing' });
        return;
    }

    try {
        // Gebruik de headers van de oorspronkelijke aanvraag,
        // met name 'User-Agent' en 'Referer' zijn belangrijk.
        const response = await fetch(targetUrl, {
            headers: req.headers,
        });

        // Stuur de headers van het doel door naar de client.
        response.headers.forEach((value, name) => {
            // Voorkom 'hop-by-hop' header fouten.
            if (!['content-encoding', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });
        
        // Stuur de statuscode en de body van het doel door.
        res.status(response.status);
        response.body.pipe(res);

    } catch (error) {
        console.error(`[PROXY ERROR] Fout bij het fetchen van ${targetUrl}:`, error);
        res.status(502).json({ error: 'Bad Gateway', message: error.message });
    }
};
