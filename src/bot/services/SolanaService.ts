import { Connection, AddressLookupTableAccount, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import https from 'https';
import { LRUCache } from 'lru-cache';

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 10, scheduling: 'fifo' });
const lutCache = new LRUCache<string, AddressLookupTableAccount>({ max: 200 });
let globalReadConnection: Connection | null = null;
let globalWriteConnection: Connection | null = null;
let globalWssConnection: Connection | null = null;

// Custom fetch wrapper conforming to standard fetch signature to enforce Keep-Alive and pooling
// @ts-ignore
const customFetch = async (input: any, init?: any): Promise<any> => {
    const url = typeof input === 'string' ? input : (input && input.url) ? input.url : input.toString();
    // @ts-ignore
    const headers = init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    const method = init?.method || 'GET';
    const body = init?.body;

    try {
        const response = await axios({
            url,
            method: method as any,
            headers,
            data: body,
            httpsAgent,
            responseType: 'text', // Expect JSON-RPC text response
            validateStatus: () => true,
        });

        // @ts-ignore
        return new Response(response.data, {
            status: response.status,
            statusText: response.statusText,
            // @ts-ignore
            headers: new Headers(response.headers as any),
        });
    } catch (error: any) {
        throw new TypeError(error.message || 'Fetch failed');
    }
};

export class SolanaService {
    static async getReadConnection(): Promise<Connection> {
        if (!globalReadConnection) {
            let rpcUrl = process.env.SOLANA_READ_RPC_URL || process.env.SOLANA_RPC_URL;
            if (!rpcUrl && process.env.SHYFT_API_KEY) {
                rpcUrl = `https://rpc.shyft.to?api_key=${process.env.SHYFT_API_KEY}`;
            } else if (!rpcUrl) {
                rpcUrl = 'https://api.mainnet-beta.solana.com';
            }
            globalReadConnection = new Connection(rpcUrl, {
                commitment: 'confirmed',
                fetch: customFetch
            });
        }
        return globalReadConnection;
    }

    static async getWriteConnection(): Promise<Connection> {
        if (!globalWriteConnection) {
            let rpcUrl = process.env.SOLANA_WRITE_RPC_URL || process.env.SOLANA_RPC_URL;
            if (!rpcUrl && process.env.SHYFT_API_KEY) {
                rpcUrl = `https://rpc.shyft.to?api_key=${process.env.SHYFT_API_KEY}`;
            } else if (!rpcUrl) {
                rpcUrl = 'https://api.mainnet-beta.solana.com';
            }
            globalWriteConnection = new Connection(rpcUrl, {
                commitment: 'confirmed',
                fetch: customFetch
            });
        }
        return globalWriteConnection;
    }

    static async getConnection(): Promise<Connection> {
        // Por padrão, retorna a conexão de leitura para compatibilidade com códigos legados
        return this.getReadConnection();
    }

    static async getWssConnection(): Promise<Connection> {
        if (!globalWssConnection) {
            let wssUrl = process.env.SOLANA_WSS_URL;
            if (!wssUrl) {
                console.warn('⚠️ SOLANA_WSS_URL not defined. Falling back to HTTP connection for WSS.');
                return this.getConnection(); // Fallback if wss is missing
            }
            let rpcUrl = process.env.SOLANA_READ_RPC_URL || process.env.SOLANA_RPC_URL;
            if (!rpcUrl && process.env.SHYFT_API_KEY) {
                rpcUrl = `https://rpc.shyft.to?api_key=${process.env.SHYFT_API_KEY}`;
            } else if (!rpcUrl) {
                rpcUrl = 'https://api.mainnet-beta.solana.com';
            }

            globalWssConnection = new Connection(rpcUrl, {
                wsEndpoint: wssUrl,
                commitment: 'confirmed',
                fetch: customFetch
            });
        }
        return globalWssConnection;
    }

    static async getDynamicJitoTip(): Promise<number> {
        try {
            const res = await axios.get('https://bundles.jito.wtf/api/v1/bundles/tip_floor', { httpsAgent, timeout: 3000 });
            let tipData = res.data;
            if (Array.isArray(tipData) && tipData.length > 0) tipData = tipData[0];
            if (tipData && typeof tipData.ema_landed_tips_50th_percentile === 'number') {
                return Math.max(Math.floor(tipData.ema_landed_tips_50th_percentile * 1e9), 15000);
            }
        } catch (err) { }
        return 25000;
    }

    static async sendJitoBundle(transactionBase58: string) {
        try {
            const blockEngineUrl = process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
            const payload = { jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[transactionBase58]] };
            const res = await axios.post(blockEngineUrl, payload, { headers: { 'Content-Type': 'application/json' }, httpsAgent, timeout: 3000 });
            return res.data;
        } catch (err: any) {
            return { error: err.response?.data || err.message };
        }
    }

    static async resolveLookupTables(lutAddresses: string[]): Promise<AddressLookupTableAccount[]> {
        const lookupTableAccounts: AddressLookupTableAccount[] = [];
        const lutsParaBuscarOnChain: string[] = [];

        for (const address of lutAddresses) {
            if (typeof address === 'string') {
                if (lutCache.has(address)) {
                    lookupTableAccounts.push(lutCache.get(address)!);
                } else {
                    lutsParaBuscarOnChain.push(address);
                }
            }
        }

        if (lutsParaBuscarOnChain.length > 0) {
            const connection = await this.getConnection();
            const publicKeys = lutsParaBuscarOnChain.map(address => new PublicKey(address));
            const accountInfos = await connection.getMultipleAccountsInfo(publicKeys);
            for (let i = 0; i < accountInfos.length; i++) {
                const accountInfo = accountInfos[i];
                if (accountInfo) {
                    const lutAccount = new AddressLookupTableAccount({ key: publicKeys[i], state: AddressLookupTableAccount.deserialize(accountInfo.data) });
                    lookupTableAccounts.push(lutAccount);
                    lutCache.set(lutsParaBuscarOnChain[i], lutAccount);
                }
            }
        }

        return lookupTableAccounts;
    }

    static deriveAssociatedTokenAddress(mint: PublicKey, owner: PublicKey) {
        const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
        const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
        const [address] = PublicKey.findProgramAddressSync(
            [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        return address;
    }
}
