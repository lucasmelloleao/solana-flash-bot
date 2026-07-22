import { PublicKey } from '@solana/web3.js';

export interface SolendPoolConfig {
    reserve: PublicKey;
    liquiditySupply: PublicKey;
    feeReceiver: PublicKey;
    lendingMarket: PublicKey;
    lendingMarketAuthority: PublicKey;
}

// ✅ Endereços verificados via save.finance (antigo Solend), fluidity.money e cryptocompare
const LENDING_MARKET = new PublicKey('4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY'); // Solend/Save Main Market
const LENDING_MARKET_AUTHORITY = new PublicKey('DdZR6zRFiUt4S5mg7AV1uKB2z1f1WzcNYCaTEEWPAuby');

export const SOLEND_POOLS: Record<string, SolendPoolConfig> = {
    // ✅ USDC Main Pool — reserve e liquiditySupply verificados via save.finance
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
        reserve: new PublicKey('BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw'),
        liquiditySupply: new PublicKey('8SheGtsopRUDzdiD6v6BR9a6bqZ9QwywYQY99Fp5meNf'),
        feeReceiver: new PublicKey('5Gdxn4yquneifE6uk9tK8X4CqHfWKjW2BvYU25hAykwP'),
        lendingMarket: LENDING_MARKET,
        lendingMarketAuthority: LENDING_MARKET_AUTHORITY
    },
    // ✅ SOL Main Pool — reserve verificado via save.finance
    'So11111111111111111111111111111111111111112': {
        reserve: new PublicKey('8PbodeaosQP19SjYFx855UMqWxH2HynZLdBXmsrbac36'),
        liquiditySupply: new PublicKey('8UviNr47Sigi3wG16w7fFvAW96R3k2UDB9t85RBNnL6Z'),
        feeReceiver: new PublicKey('5Gdxn4yquneifE6uk9tK8X4CqHfWKjW2BvYU25hAykwP'),
        lendingMarket: LENDING_MARKET,
        lendingMarketAuthority: LENDING_MARKET_AUTHORITY
    },
    // ✅ USDT Main Pool — reserve verificado via save.finance
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': {
        reserve: new PublicKey('8K9WC8xoh2rtQNY7iEGXtPvfbDCi563SdWhCAhuMP2xE'),
        liquiditySupply: new PublicKey('8B5u6i9C9XQGimxQJtGZkEqqKkQvQyPqyLbq9fG7pBqS'),
        feeReceiver: new PublicKey('5Gdxn4yquneifE6uk9tK8X4CqHfWKjW2BvYU25hAykwP'),
        lendingMarket: LENDING_MARKET,
        lendingMarketAuthority: LENDING_MARKET_AUTHORITY
    }
};

export function getSolendPoolConfig(tokenMint: string): SolendPoolConfig {
    const config = SOLEND_POOLS[tokenMint];
    if (!config) {
        throw new Error(`Solend Pool configuration not found for mint: ${tokenMint}`);
    }
    return config;
}
