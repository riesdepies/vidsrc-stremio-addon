// /api/proxy.js

const axios = require('axios');

async function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        req.on('error', (err) => { reject(err); });
    });
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') { return res.status(204).end(); }
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { targetUrl, headers } = await parseJsonBody(req);
        if (!targetUrl) {
            return res.status(400).json({ error: 'Bad Request: targetUrl is required' });
        }
        
        const response = await axios.get(targetUrl, {
            headers: headers,
            timeout: 15000,
            responseType: 'text',
            validateStatus: () => true 
        });

        res.status(200).json({
            status: response.status,
            statusText: response.statusText,
            body: response.data
        });

    } catch (error) {
        console.error(`[PROXY ERROR] Fout bij verwerken proxy request:`, error.message);
        res.status(500).json({ 
            error: 'Proxy request failed', 
            details: error.message 
        });
    }
};
