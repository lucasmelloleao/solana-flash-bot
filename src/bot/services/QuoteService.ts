import axios from 'axios';
import https from 'https';
import redisClient from './RedisService';

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 10, scheduling: 'fifo' });
const jupApiUrl = process.env.JUPITER_URL || 'https://api.jup.ag/swap/v1';
const jupApiKey = process.env.JUPITER_API_KEY;
console.log(`🪐 [QuoteService] Roteador Jupiter configurado para: ${jupApiUrl}`);

const headers: any = {};
if (jupApiKey) {
    headers['x-api-key'] = jupApiKey;
    console.log(`🔑 [QuoteService] Autenticação Jupiter (API Key) ATIVADA!`);
}

const jupApi = axios.create({ baseURL: jupApiUrl, httpsAgent, timeout: 3000, headers });
const raptorApi = axios.create({ baseURL: 'https://raptor-beta.solanatracker.io', httpsAgent, timeout: 2000 });

export class QuoteService {
    static async fetchSolPriceUsdc(): Promise<number> {
        try {
            if (redisClient) {
                const cached = await redisClient.get('cache:sol_price');
                if (cached) return parseFloat(cached);
            }
            const res = await axios.get('https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112', { httpsAgent, timeout: 3000 });
            const data = res.data?.['So11111111111111111111111111111111111111112'];
            if (data && data.usdPrice) {
                const price = parseFloat(data.usdPrice);
                if (redisClient) await redisClient.set('cache:sol_price', price.toString(), 'EX', 15);
                return price;
            }
        } catch (err) { }
        return 150; // Fallback
    }

    static async getQuotes(tokenMint: string, borrowAmount: number, useRaptor: boolean) {
        const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const cacheKey = `cache:quote:${tokenMint}:${borrowAmount}:${useRaptor}`;
        
        if (redisClient) {
            const cached = await redisClient.get(cacheKey);
            if (cached) return JSON.parse(cached);
        }

        let quoteA, quoteB;
        try {
            if (useRaptor) {
                const quoteARes = await raptorApi.get(`/quote?inputMint=${USDC_MINT}&outputMint=${tokenMint}&amount=${borrowAmount}&slippageBps=50&maxAccounts=28`);
                quoteA = quoteARes.data;
                if (!quoteA || !quoteA.amountOut) return null;
                const quoteBRes = await raptorApi.get(`/quote?inputMint=${tokenMint}&outputMint=${USDC_MINT}&amount=${quoteA.amountOut}&slippageBps=50&maxAccounts=28`);
                quoteB = quoteBRes.data;
            } else {
                const quoteARes = await jupApi.get(`/quote?inputMint=${USDC_MINT}&outputMint=${tokenMint}&amount=${borrowAmount}&slippageBps=50`);
                quoteA = quoteARes.data;
                if (!quoteA) return null;
                const quoteBRes = await jupApi.get(`/quote?inputMint=${tokenMint}&outputMint=${USDC_MINT}&amount=${quoteA.outAmount}&slippageBps=50`);
                quoteB = quoteBRes.data;
            }
            if (!quoteB) return null;

            const result = { quoteA, quoteB };
            if (redisClient) {
                await redisClient.set(cacheKey, JSON.stringify(result), 'PX', 400); // 400ms cache para acompanhar as pools sem atraso
            }
            return result;
        } catch (error) {
            console.log('QuoteService: getQuotes error', error)
            throw error;
        }
    }

    static async getSwapInstructions(quoteResponse: any, userPublicKeyBase58: string, useRaptor: boolean) {
        const swapApi = useRaptor ? raptorApi : jupApi;
        //const res = await raptorApi.post('/swap-instructions', {
        const res = await swapApi.post('/swap-instructions', {
            quoteResponse,
            userPublicKey: userPublicKeyBase58,
            wrapAndUnwrapSol: false,
            asLegacyTransaction: false
        });
        return res.data;
    }
}
