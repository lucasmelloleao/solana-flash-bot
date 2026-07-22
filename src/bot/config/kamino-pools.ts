import { PublicKey } from '@solana/web3.js';

export interface KaminoPoolConfig {
    reserve: PublicKey;
    liquiditySupply: PublicKey;
    feeReceiver: PublicKey;
    lendingMarket: PublicKey;
    lendingMarketAuthority: PublicKey;
    mint: PublicKey;
}

// ✅ Endereços do Market verificados via script on-chain
const LENDING_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'); // Kamino Main Market ✅
const LENDING_MARKET_AUTHORITY = new PublicKey('9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo'); // ✅ Verificado on-chain (PDA do LMA)

export const KAMINO_POOLS: Record<string, KaminoPoolConfig> = {
    // USDC Main Market (Kamino)
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
        reserve: new PublicKey('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59'),         // ✅ Verificado on-chain
        liquiditySupply: new PublicKey('9qUr28Chijx7H7Sqhc4Hbv7C5nTZuYRRsDV9xqjy1QLY'), // ✅ Verificado on-chain
        feeReceiver: new PublicKey('6G9iJB3ABVfjsksfJiEQAY2abpjKQW7ZbjZHK8zUygMm'),     // ✅ Verificado on-chain
        lendingMarket: LENDING_MARKET,
        lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
        mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    },
    // SOL Main Market (Kamino)
    'So11111111111111111111111111111111111111112': {
        reserve: new PublicKey('d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q'),         // ✅ Verificado on-chain
        liquiditySupply: new PublicKey('V8gufqCgjFwD2nJGPZ99Lkh4J28GGBJaWkjgjrj5YoW'), // ✅ Verificado on-chain
        feeReceiver: new PublicKey('5fwndGoVdTBGz3w4JssZmevg55wbBPKHPDPAaDpZD1Aw'),     // ✅ Verificado on-chain
        lendingMarket: LENDING_MARKET,
        lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
        mint: new PublicKey('So11111111111111111111111111111111111111112')
    }
};

export function getKaminoPoolConfig(tokenMint: string): KaminoPoolConfig {
    const config = KAMINO_POOLS[tokenMint];
    if (!config) {
        throw new Error(`Kamino Pool configuration not found for mint: ${tokenMint}`);
    }
    // Aviso em caso de endereços não verificados (contém padrões conhecidos de placeholders)
    const invalidPatterns = ['11111111111111111111111111111111'];
    const fields = ['reserve', 'liquiditySupply', 'feeReceiver'] as const;
    for (const field of fields) {
        if (invalidPatterns.includes(config[field].toBase58())) {
            console.warn(`⚠️ [KaminoPools] ATENÇÃO: ${field} para mint ${tokenMint} ainda é um placeholder (System Program). Execute: npx ts-node src/scripts/fetch-kamino-reserves.ts`);
        }
    }
    return config;
}
