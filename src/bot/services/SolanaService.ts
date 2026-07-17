import { Connection, AddressLookupTableAccount, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import https from 'https';
import { LRUCache } from 'lru-cache';

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 10, scheduling: 'fifo' });
const lutCache = new LRUCache<string, AddressLookupTableAccount>({ max: 200 });
let globalConnection: Connection | null = null;
let globalWssConnection: Connection | null = null;

export class SolanaService {
    static async getConnection(): Promise<Connection> {
        if (!globalConnection) {
            let rpcUrl = process.env.SOLANA_RPC_URL;
            if (!rpcUrl && process.env.SHYFT_API_KEY) {
                rpcUrl = `https://rpc.shyft.to?api_key=${process.env.SHYFT_API_KEY}`;
            } else if (!rpcUrl) {
                rpcUrl = 'https://api.mainnet-beta.solana.com';
            }
            globalConnection = new Connection(rpcUrl, 'confirmed');
        }
        return globalConnection;
    }

    static async getWssConnection(): Promise<Connection> {
        if (!globalWssConnection) {
            let wssUrl = process.env.SOLANA_WSS_URL;
            if (!wssUrl) {
                console.warn('⚠️ SOLANA_WSS_URL not defined. Falling back to HTTP connection for WSS.');
                return this.getConnection(); // Fallback if wss is missing
            }
            let rpcUrl = process.env.SOLANA_RPC_URL;
            if (!rpcUrl && process.env.SHYFT_API_KEY) {
                rpcUrl = `https://rpc.shyft.to?api_key=${process.env.SHYFT_API_KEY}`;
            } else if (!rpcUrl) {
                rpcUrl = 'https://api.mainnet-beta.solana.com';
            }

            globalWssConnection = new Connection(rpcUrl, {
                wsEndpoint: wssUrl,
                commitment: 'confirmed'
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
            const payload = { jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[transactionBase58]] };
            const res = await axios.post('https://mainnet.block-engine.jito.wtf/api/v1/bundles', payload, { headers: { 'Content-Type': 'application/json' }, httpsAgent, timeout: 3000 });
            return res.data;
        } catch (err) {
            return null;
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
