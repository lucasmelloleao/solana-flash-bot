import { PublicKey } from '@solana/web3.js';

export interface TargetPoolInfo {
    address: PublicKey;
    name: string;
}

// Map of TokenA_TokenB mint combinations to their liquidity pools.
// Mints are sorted alphabetically to avoid duplicate/reversed configurations.
export const TARGET_POOLS: Record<string, TargetPoolInfo[]> = {
    // USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) <-> SOL (So11111111111111111111111111111111111111112)
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:So11111111111111111111111111111111111111112': [
        {
            address: new PublicKey('58oQADJishJZ5KrxmqZc15d5EFAHTc42dAFNWtVK5or7'),
            name: 'Raydium V4 SOL/USDC AMM'
        },
        {
            address: new PublicKey('8sXYo2vy7n9L2CacA4B95g6PqF1rJ1nS4vKxN8tB3B1A'),
            name: 'Raydium CLMM SOL/USDC'
        },
        {
            address: new PublicKey('AR1m43Jdhj1tHAysE625PrmKH4qV4fELyA9k2GauB6m9'),
            name: 'Meteora DLMM SOL/USDC'
        },
        {
            address: new PublicKey('HJPnJiwzcZwrEkH2LqcP9Tmj4BvUqSstK5y987mE228j'),
            name: 'Orca SOL/USDC Whirlpool'
        }
    ],
    // USDT (Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB) <-> USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': [
        {
            address: new PublicKey('D8oc2GBwUg69HG6Ghe2Zs59YBizJTe7usvB311foF183'),
            name: 'Raydium V4 USDC/USDT AMM'
        },
        {
            address: new PublicKey('AR1m43Jdhj1tHAysE625PrmKH4qV4fELyA9k2GauB6m9'), // Placeholder/Example
            name: 'Meteora Dynamic USDC/USDT AMM'
        }
    ]
};

/**
 * Normalizes two mint strings by sorting them alphabetically and returns the list of target pool configurations.
 */
export function getTargetPools(mintA: string, mintB: string): TargetPoolInfo[] {
    const sorted = [mintA, mintB].sort();
    const key = `${sorted[0]}:${sorted[1]}`;
    return TARGET_POOLS[key] || [];
}
