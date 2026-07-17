import http from 'http';
import url from 'url';
import axios from 'axios';
import { LRUCache } from 'lru-cache';

const JUPITER_API = 'https://public.jupiterapi.com';
const PORT = 8080;

// Caches quotes for 1.5 seconds to bypass strict rate-limits of public API during fast polling
const quoteCache = new LRUCache<string, any>({
    max: 200,
    ttl: 1500
});

const server = http.createServer(async (req, res) => {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url || '', true);
    const pathname = parsedUrl.pathname;

    if (pathname === '/quote') {
        const query = parsedUrl.query;
        const cacheKey = JSON.stringify(query);

        const cached = quoteCache.get(cacheKey);
        if (cached) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(cached));
            return;
        }

        try {
            const response = await axios.get(`${JUPITER_API}/quote`, {
                params: query,
                timeout: 3000
            });
            quoteCache.set(cacheKey, response.data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response.data));
        } catch (error: any) {
            const status = error.response?.status || 500;
            const data = error.response?.data || { error: error.message };
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        }
    } else if (pathname === '/swap-instructions' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            try {
                const response = await axios.post(`${JUPITER_API}/swap-instructions`, JSON.parse(body), {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 4000
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response.data));
            } catch (error: any) {
                const status = error.response?.status || 500;
                const data = error.response?.data || { error: error.message };
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
});

server.listen(PORT, () => {
    console.log('\n=============================================');
    console.log(`🪐 [MOCK JUPITER SERVER] Rodando na porta ${PORT}`);
    console.log(`🔗 Redirecionando requisições para: ${JUPITER_API}`);
    console.log('⚡ Cache de 1.5s ativo para evitar erro 429 (Rate Limit)');
    console.log('=============================================\n');
});
