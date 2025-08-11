// /api/proxy.js

const fetch = require('node-fetch');

// Helper om de request body te parsen
function parseJSON(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', (err) => {
            reject(err);
        });
    });
}

module.exports = async (req, res) => {
    // Sta cross-origin requests toe
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    // Behandel pre-flight OPTIONS requests
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Accepteer alleen POST-verzoeken
    if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    }

    try {
        const { targetUrl, fetchOptions } = await parseJSON(req);

        if (!targetUrl) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ error: 'targetUrl is required' }));
        }

        // Voer de daadwerkelijke fetch uit naar de doel-URL met de meegestuurde opties
        const proxyResponse = await fetch(targetUrl, fetchOptions);

        // Stuur de headers van het doel antwoord door
        proxyResponse.headers.forEach((value, name) => {
            // Voorkom 'Transfer-Encoding' header problemen op Vercel
            if (name.toLowerCase() !== 'transfer-encoding') {
                res.setHeader(name, value);
            }
        });

        // Stuur de statuscode van het doel antwoord door
        res.statusCode = proxyResponse.status;

        // Stream het antwoord body direct door
        proxyResponse.body.pipe(res);

    } catch (error) {
        console.error('[PROXY ERROR]', error);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Proxy failed to fetch the request', details: error.message }));
    }
};
