import { PublicKey } from '@solana/web3.js';

export interface KaminoPoolConfig {
    reserve: PublicKey;
    liquiditySupply: PublicKey;
    feeReceiver: PublicKey;
    lendingMarket: PublicKey;
    lendingMarketAuthority: PublicKey;
    mint: PublicKey;
}

const LENDING_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNfHcw31t2hH5P7QgbQ2o3Qn'); // Kamino Main Market
const LENDING_MARKET_AUTHORITY = new PublicKey('9VddCF6iEyNs8iqrhRoCJqmTXAViyTPQodbfAKWFR4NW');

export const KAMINO_POOLS: Record<string, KaminoPoolConfig> = {
    // USDC Main Market
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
        reserve: new PublicKey('D6ndFQpMvLh1LffjF576M75G2jF8yZ6wXhUfL2bHqVp1'),
        liquiditySupply: new PublicKey('G4XvP5t7oNMBR7M6iEbqmF2T9R4sMkWjM5xK2D6XF9K2'),
        feeReceiver: new PublicKey('6W9sP7c4iNMBR7M6iEbqmF2T9R4sMkWjM5xK2D6XF9K2'), // Placeholder, often not used directly for host fee in kamino, but we keep the structure
        lendingMarket: LENDING_MARKET,
        lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
        mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    },
    // SOL Main Market
    'So11111111111111111111111111111111111111112': {
        reserve: new PublicKey('11111111111111111111111111111111'),
        liquiditySupply: new PublicKey('11111111111111111111111111111111'),
        feeReceiver: new PublicKey('11111111111111111111111111111111'),
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
    return config;
}
