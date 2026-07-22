import { PublicKey } from '@solana/web3.js';

export interface TargetPoolInfo {
    address: PublicKey;
    name: string;
}

// Map of TokenA_TokenB mint combinations to their liquidity pools.
// Mints are sorted alphabetically to avoid duplicate/reversed configurations.
// ✅ Endereços verificados via API oficial do Raydium (api-v3.raydium.io) e documentação Orca.
export const TARGET_POOLS: Record<string, TargetPoolInfo[]> = {
    // USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) <-> SOL (So11111111111111111111111111111111111111112)
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:So11111111111111111111111111111111111111112': [
        {
            // ✅ Raydium V4 AMM SOL/USDC — verificado via api-v3.raydium.io | TVL ~$10M | fee 0.25%
            address: new PublicKey('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'),
            name: 'Raydium V4 SOL/USDC AMM'
        },
        {
            // ✅ Raydium CLMM SOL/USDC (0.04%, tickSpacing=1) — verificado via api-v3.raydium.io | TVL ~$6.1M | maior volume
            address: new PublicKey('3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv'),
            name: 'Raydium CLMM SOL/USDC (0.04%)'
        },
        {
            // ✅ Raydium CLMM SOL/USDC (0.02%, tickSpacing=1) — verificado via api-v3.raydium.io | TVL ~$335k
            address: new PublicKey('CYbD9RaToYMtWKA7QZyoLahnHdWq553Vm62Lh6qWtuxq'),
            name: 'Raydium CLMM SOL/USDC (0.02%)'
        },
        {
            // ✅ Orca SOL/USDC Whirlpool (0.04% fee tier) — verificado via GeckoTerminal, docs Orca e Jupiter
            address: new PublicKey('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'),
            name: 'Orca SOL/USDC Whirlpool (0.04%)'
        }
    ],
    // USDT (Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB) <-> USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': [
        {
            // ✅ Raydium V4 USDC/USDT AMM — endereço verificado via Raydium SDK
            address: new PublicKey('D8oc2GBwUg69HG6Ghe2Zs59YBizJTe7usvB311foF183'),
            name: 'Raydium V4 USDC/USDT AMM'
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
