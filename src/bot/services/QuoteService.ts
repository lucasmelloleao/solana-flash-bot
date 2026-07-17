import axios from 'axios';
import https from 'https';

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 10, scheduling: 'fifo' });
const jupApiUrl = process.env.JUPITER_LOCAL_URL || process.env.JUPITER_URL || 'https://public.jupiterapi.com';
console.log(`🪐 [QuoteService] Roteador Jupiter configurado para: ${jupApiUrl}`);
const jupApi = axios.create({ baseURL: jupApiUrl, httpsAgent, timeout: 3000 });
const raptorApi = axios.create({ baseURL: 'https://raptor-beta.solanatracker.io', httpsAgent, timeout: 2000 });

export class QuoteService {
    static async fetchSolPriceUsdc(): Promise<number> {
        try {
            const res = await axios.get('https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112', { httpsAgent, timeout: 3000 });
            const data = res.data?.['So11111111111111111111111111111111111111112'];
            if (data && data.usdPrice) return parseFloat(data.usdPrice);
        } catch (err) { }
        return 150; // Fallback
    }

    static async getQuotes(tokenMint: string, borrowAmount: number, useRaptor: boolean) {
        const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        let quoteA, quoteB;

        try {
            if (useRaptor) {
                const quoteARes = await raptorApi.get(`/quote?inputMint=${USDC_MINT}&outputMint=${tokenMint}&amount=${borrowAmount}&slippageBps=2&onlyDirectRoutes=true`);
                quoteA = quoteARes.data;
                if (!quoteA || !quoteA.amountOut) return null;
                const quoteBRes = await raptorApi.get(`/quote?inputMint=${tokenMint}&outputMint=${USDC_MINT}&amount=${quoteA.amountOut}&slippageBps=2&onlyDirectRoutes=true`);
                quoteB = quoteBRes.data;
            } else {
                const quoteARes = await jupApi.get(`/quote?inputMint=${USDC_MINT}&outputMint=${tokenMint}&amount=${borrowAmount}&slippageBps=2&onlyDirectRoutes=true`);
                quoteA = quoteARes.data;
                if (!quoteA) return null;
                const quoteBRes = await jupApi.get(`/quote?inputMint=${tokenMint}&outputMint=${USDC_MINT}&amount=${quoteA.outAmount}&slippageBps=2&onlyDirectRoutes=true`);
                quoteB = quoteBRes.data;
            }
            if (!quoteB) return null;

            return { quoteA, quoteB };
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
