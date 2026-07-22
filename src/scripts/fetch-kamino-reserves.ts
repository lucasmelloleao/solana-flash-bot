/**
 * Script utilitário para buscar e exibir os endereços reais das reserves do Kamino
 * a partir do RPC da Solana. Execute com:
 *    npx ts-node --transpile-only src/scripts/fetch-kamino-reserves.ts
 *
 * Os endereços retornados devem ser colados em src/bot/config/kamino-pools.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { Connection, PublicKey } from '@solana/web3.js';

const KAMINO_MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNfHcw31t2hH5P7QgbQ2o3Qn';
const KAMINO_PROGRAM_ID = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';

const MINTS_TO_CHECK = [
    { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    { symbol: 'SOL',  mint: 'So11111111111111111111111111111111111111112' },
    { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
];

async function main() {
    const rpcUrl = process.env.SOLANA_RPC_URL || process.env.SOLANA_READ_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');

    console.log(`\n🔍 Carregando Kamino Main Market: ${KAMINO_MAIN_MARKET}`);
    console.log(`   RPC: ${rpcUrl}\n`);

    try {
        // Carrega o market account diretamente para extrair as reserves sem depender da tipagem do SDK
        const { KaminoMarket } = await import('@kamino-finance/klend-sdk');
        const market = await (KaminoMarket as any).load(connection, new PublicKey(KAMINO_MAIN_MARKET));

        if (!market) {
            throw new Error('Market retornou null — verifique o endereço e o RPC.');
        }

        if (typeof market.loadReserves === 'function') await market.loadReserves();

        const reserves: any[] = typeof market.getReserves === 'function' ? market.getReserves() : [];

        console.log(`✅ ${reserves.length} reserves encontradas.\n`);
        console.log('// ===== Cole este bloco em src/bot/config/kamino-pools.ts =====');
        console.log('export const KAMINO_POOLS: Record<string, KaminoPoolConfig> = {');

        for (const { symbol, mint } of MINTS_TO_CHECK) {
            const matching = reserves.filter((r: any) => {
                try {
                    const mintAddr = typeof r.getLiquidityMint === 'function'
                        ? r.getLiquidityMint().toBase58()
                        : r.state?.liquidity?.mintPubkey?.toBase58?.();
                    return mintAddr === mint;
                } catch { return false; }
            });

            if (matching.length === 0) {
                console.log(`    // ⚠️ ${symbol} reserve NÃO encontrada no market`);
                continue;
            }

            const reserve = matching[0];
            const reserveAddr = reserve.address?.toBase58?.() || '⚠️ N/A';
            const state = reserve.state || {};
            const liquidity = state.liquidity || {};

            const liquiditySupply = liquidity.supplyVault?.toBase58?.()
                || liquidity.supplyPubkey?.toBase58?.()
                || '⚠️ NÃO ENCONTRADO';
            const feeReceiver = liquidity.feeVault?.toBase58?.()
                || state.config?.feeConfig?.feeReceiver?.toBase58?.()
                || '⚠️ NÃO ENCONTRADO';
            const lendingMarket = state.lendingMarket?.toBase58?.() || KAMINO_MAIN_MARKET;

            console.log(`    // ${symbol} Main Market`);
            console.log(`    '${mint}': {`);
            console.log(`        reserve: new PublicKey('${reserveAddr}'),`);
            console.log(`        liquiditySupply: new PublicKey('${liquiditySupply}'),`);
            console.log(`        feeReceiver: new PublicKey('${feeReceiver}'),`);
            console.log(`        lendingMarket: new PublicKey('${lendingMarket}'),`);
            console.log(`        lendingMarketAuthority: LENDING_MARKET_AUTHORITY,`);
            console.log(`        mint: new PublicKey('${mint}')`);
            console.log(`    },`);
        }

        console.log('};\n');
        console.log('// ===== Fim do bloco =====');

    } catch (err: any) {
        console.error('❌ Falha ao carregar o market Kamino:', err.message || err);
        console.error('\nAlternativa manual: acesse https://app.kamino.finance e inspecione os reserve accounts via Solscan');
    }
}

main().catch(console.error);
