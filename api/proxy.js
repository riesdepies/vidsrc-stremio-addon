// /api/proxy.js
const fetch = require('node-fetch');

module.exports = async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'URL parameter is missing' });
    }

    try {
        // Stuur de headers van de oorspronkelijke aanvraag door.
        const response = await fetch(targetUrl, {
            headers: req.headers,
        });

        // Stuur de headers van het doel door naar de client.
        response.headers.forEach((value, name) => {
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
