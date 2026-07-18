import dotenv from 'dotenv';
dotenv.config();

import { Keypair, PublicKey } from '@solana/web3.js';
import { DatabaseService } from '../../services/DatabaseService';
import { QuoteService } from '../../services/QuoteService';
import { SolanaService } from '../../services/SolanaService';
import { TransactionBuilder } from '../../services/TransactionBuilder';
import { createFlashLoanBorrowInstruction as borrowFlashLoanFromSolend, createFlashLoanRepayInstruction as repayFlashLoanToSolend } from './solend-helper';
import { createKaminoFlashLoanBorrowInstruction as borrowFlashLoanFromKamino, createKaminoFlashLoanRepayInstruction as repayFlashLoanToKamino } from './kamino-helper';
import { getSolendPoolConfig } from '../../config/solend-pools';
import { getKaminoPoolConfig } from '../../config/kamino-pools';
import FlashLoanTrade from '../../../models/FlashLoanTrade';
import { getTargetPools } from '../../config/target-pools';
const SystemStatus = require('../../../models/SystemStatus').default || require('../../../models/SystemStatus');

// Logger Mock
let logger = {
    info: (obj: any, msg?: string) => console.log(`[INFO] ${msg || ''}`, typeof obj === 'string' ? obj : JSON.stringify(obj)),
    warn: (obj: any, msg?: string) => console.warn(`[WARN] ${msg || ''}`, typeof obj === 'string' ? obj : JSON.stringify(obj)),
    error: (obj: any, msg?: string) => console.error(`[ERROR] ${msg || ''}`, typeof obj === 'string' ? obj : JSON.stringify(obj)),
};

let botMode = 'simulated';
let connectionMode = 'rpc';
let isAnalyzing = false;
let globalPenaltyMs = 0;
let lastExecutionTime = 0;
// Throttle requests to Jupiter/Raptor: max ~1 per 800ms to avoid rate limits while being fast
const MIN_INTERVAL_MS = 800;

let latestJitoTipLamports = 25000;
let cachedStrategies: any[] = [];
let cachedSolPriceUsdc = 150;
let userIdCache: string | null = null;
const temporaryAttempts = new Map<string, number>();

let walletCache: Map<string, { keypair: Keypair, usdcAta: PublicKey, balance: number }> = new Map();

const circuitBreaker = {
    consecutiveFailures: 0,
    accumulatedLossUsdc: 0,
    isOpen: false,
    maxConsecutiveFailures: 5,
    maxAccumulatedLossUsdc: 10,
    cooldownMs: 60000,
    openedAt: 0,
    recordFailure(lossUsdc = 0) {
        this.consecutiveFailures++;
        this.accumulatedLossUsdc += lossUsdc;
        if (this.consecutiveFailures >= this.maxConsecutiveFailures || this.accumulatedLossUsdc >= this.maxAccumulatedLossUsdc) {
            this.open();
        }
    },
    open() {
        this.isOpen = true;
        this.openedAt = Date.now();
        logger.warn({ consecutiveFailures: this.consecutiveFailures, accumulatedLossUsdc: this.accumulatedLossUsdc }, '🛑 Circuit breaker ABERTO');
    },
    check() {
        if (!this.isOpen) return true;
        if (Date.now() - this.openedAt > this.cooldownMs) {
            this.isOpen = false;
            this.consecutiveFailures = 0;
            this.accumulatedLossUsdc = 0;
            logger.info('✅ Circuit breaker FECHADO');
            return true;
        }
        return false;
    }
};

const lastStrategyRunTimes = new Map<string, number>();
let activeTargetPools: { address: PublicKey; mintA: string; mintB: string }[] = [];
let targetPoolSubscriptionIds: number[] = [];
const lastKnownPoolStates = new Map<string, string>();
const FAST_POLL_INTERVAL_MS = 200;

async function resubscribePoolAccounts() {
    if (targetPoolSubscriptionIds.length > 0) {
        console.log(`\n🧹 Cancelando inscrição de ${targetPoolSubscriptionIds.length} pools...`);
        for (const subId of targetPoolSubscriptionIds) {
            try {
                await wssConnectionInstance.removeAccountChangeListener(subId);
            } catch (e) {}
        }
        targetPoolSubscriptionIds = [];
    }

    if (activeTargetPools.length === 0) return;

    console.log(`🔌 Inscrevendo em mudanças de conta para ${activeTargetPools.length} pools...`);
    for (const poolInfo of activeTargetPools) {
        try {
            const subId = wssConnectionInstance.onAccountChange(
                poolInfo.address,
                (accountInfo: any) => {
                    const poolAddr = poolInfo.address.toBase58();
                    const currentData = accountInfo.data ? accountInfo.data.toString('base64') : '';
                    const lastData = lastKnownPoolStates.get(poolAddr) || '';

                    if (currentData !== lastData) {
                        lastKnownPoolStates.set(poolAddr, currentData);
                        triggerTargetedArbitrageCycle(poolInfo.mintA, poolInfo.mintB).catch(err => {
                            console.error(`❌ Erro no ciclo de arbitragem direcionado para ${poolInfo.mintA}/${poolInfo.mintB}:`, err);
                        });
                    }
                },
                'confirmed'
            );
            targetPoolSubscriptionIds.push(subId);
        } catch (err) {
            console.error(`❌ Falha ao inscrever no pool ${poolInfo.address.toBase58()}:`, err);
        }
    }
}

async function reloadState() {
    cachedStrategies = await DatabaseService.getActiveStrategies();
    if (cachedStrategies.length > 0) {
        userIdCache = cachedStrategies[0].userId.toString();

        const USDC_MINT_PK = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
        const conn = await SolanaService.getConnection();

        const uniqueWalletIds = [...new Set(cachedStrategies.map(s => s.walletId?.toString()).filter(Boolean))];

        for (const walletId of uniqueWalletIds) {
            if (!walletCache.has(walletId)) {
                const keypair = await DatabaseService.getWalletById(walletId); // Fetches the specific wallet requested
                if (keypair) {
                    const usdcAta = SolanaService.deriveAssociatedTokenAddress(USDC_MINT_PK, keypair.publicKey);
                    const balance = await conn.getBalance(keypair.publicKey);
                    walletCache.set(walletId, { keypair, usdcAta, balance });
                }
            } else {
                const cached = walletCache.get(walletId)!;
                cached.balance = await conn.getBalance(cached.keypair.publicKey);
            }
        }

        // Resolve os pools alvo ativos para monitoramento
        const resolvedPoolsMap = new Map<string, { address: PublicKey; mintA: string; mintB: string }>();
        for (const strategy of cachedStrategies) {
            const tokenA = strategy.tokenAMint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
            const tokenB = strategy.tokenBMint;
            const pools = getTargetPools(tokenA, tokenB);
            for (const pool of pools) {
                resolvedPoolsMap.set(pool.address.toBase58(), {
                    address: pool.address,
                    mintA: tokenA,
                    mintB: tokenB
                });
            }
        }
        const newActiveTargetPools = Array.from(resolvedPoolsMap.values());
        const oldKeys = activeTargetPools.map(p => p.address.toBase58()).sort().join(',');
        const newKeys = newActiveTargetPools.map(p => p.address.toBase58()).sort().join(',');

        if (oldKeys !== newKeys) {
            activeTargetPools = newActiveTargetPools;
            // Se o modo for WSS, atualiza as inscrições
            if (connectionMode === 'wss' && wssConnectionInstance) {
                await resubscribePoolAccounts().catch(err => {
                    console.error('Erro ao re-inscrever em pools:', err);
                });
            }
        } else {
            activeTargetPools = newActiveTargetPools;
        }
    } else {
        activeTargetPools = [];
    }
}

async function runSingleStrategyArbitrage(strategy: any) {
    try {
        if (strategy.temporary) {
            const attempts = temporaryAttempts.get(strategy._id.toString()) || 0;
            if (attempts >= 10) {
                await DatabaseService.deleteStrategy(strategy._id.toString());
                temporaryAttempts.delete(strategy._id.toString());
                cachedStrategies = cachedStrategies.filter(s => s._id.toString() !== strategy._id.toString());
                return;
            }
            temporaryAttempts.set(strategy._id.toString(), attempts + 1);
        }

        const tokenBorrowed = strategy.tokenAMint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // Defaults to USDC
        const lendingProvider = strategy.lendingProvider || 'none';

        let poolConfig = null;
        if (lendingProvider === 'kamino') {
            poolConfig = getKaminoPoolConfig(tokenBorrowed);
        } else if (lendingProvider === 'solend') {
            poolConfig = getSolendPoolConfig(tokenBorrowed);
        }

        const BORROW_AMOUNT = Math.floor(strategy.borrowAmount * 1e6);
        const useRaptor = strategy.provider === 'raptor';

        const quotes = await QuoteService.getQuotes(strategy.tokenBMint, BORROW_AMOUNT, useRaptor);
        if (!quotes) return;

        const { quoteA, quoteB } = quotes;
        const flashLoanFee = lendingProvider === 'none' ? 0 : Math.ceil((BORROW_AMOUNT * 9) / 10000); // 0.09% para Solend/Kamino, 0 no capital próprio

        let finalAmount = useRaptor ? parseInt(quoteB.amountOut) : parseInt(quoteB.outAmount);
        if (useRaptor) finalAmount = Math.floor(finalAmount * 0.995);

        const jitoTipCostUsdc = (latestJitoTipLamports / 1e9) * cachedSolPriceUsdc;
        const priorityFeeCostUsdc = ((500000 * 40000) / 1e15) * cachedSolPriceUsdc;
        const totalExecutionCostMicroUsdc = Math.ceil((jitoTipCostUsdc + priorityFeeCostUsdc) * 1e6);

        const profit = finalAmount - (BORROW_AMOUNT + flashLoanFee + totalExecutionCostMicroUsdc);

        if (profit >= (strategy.minProfitUsdc * 1e6)) {
            logger.info({ profitUsdc: (profit / 1e6).toFixed(4) }, '💰 OPORTUNIDADE DETECTADA');

            if (botMode === 'live' && !circuitBreaker.check()) return;

            const tradeLog = await FlashLoanTrade.create({
                userId: strategy.userId,
                tokenBorrowed: 'USDC',
                amountBorrowed: BORROW_AMOUNT / 1e6,
                expectedProfit: profit / 1e6,
                flashLoanFee: flashLoanFee / 1e6,
                status: botMode === 'live' ? 'pending' : 'simulated',
                routeInfo: { quoteA, quoteB }
            });

            const executionWallet = strategy.walletId ? walletCache.get(strategy.walletId.toString()) : null;
            if (executionWallet && botMode === 'live') {
                if (executionWallet.balance < latestJitoTipLamports + 30000) {
                    logger.error('Saldo de SOL insuficiente para o Jito Tip na carteira de execução. Abortando.');
                    return;
                }

                const pubkeyBase58 = executionWallet.keypair.publicKey.toBase58();
                const instructionsARes = await QuoteService.getSwapInstructions(quoteA, pubkeyBase58, useRaptor);
                const instructionsBRes = await QuoteService.getSwapInstructions(quoteB, pubkeyBase58, useRaptor);

                try {
                    const result = await TransactionBuilder.buildAndSendArbitrage(
                        executionWallet.keypair,
                        BORROW_AMOUNT,
                        flashLoanFee,
                        latestJitoTipLamports,
                        instructionsARes,
                        instructionsBRes,
                        lendingProvider === 'none' ? null : executionWallet.usdcAta,
                        poolConfig,
                        lendingProvider
                    );

                    if (result) {
                        tradeLog.txid = result.txid;
                        tradeLog.gasFee = latestJitoTipLamports / 1e9;
                        if (result.jitoBundleId) {
                            tradeLog.jitoBundleId = result.jitoBundleId;
                            await tradeLog.save();
                            logger.info({ txid: result.txid, bundleId: result.jitoBundleId, expectedProfit: (profit / 1e6).toFixed(4) }, '🚀 TRANSAÇÃO ENVIADA COM SUCESSO (Aguardando confirmação...)');
                            
                            // Checagem assíncrona de confirmação de lucro
                            SolanaService.getConnection().then(async conn => {
                                try {
                                    const latestBlockhash = await conn.getLatestBlockhash('confirmed');
                                    const confirmation = await conn.confirmTransaction({
                                        signature: result.txid,
                                        blockhash: latestBlockhash.blockhash,
                                        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
                                    }, 'confirmed');
                                    
                                    if (confirmation.value.err) {
                                        logger.error({ txid: result.txid, err: confirmation.value.err }, '❌ TRANSAÇÃO FALHOU NA REDE (Revertida)');
                                        await FlashLoanTrade.deleteOne({ _id: tradeLog._id });
                                    } else {
                                        logger.info({ txid: result.txid, profitUsdc: (profit / 1e6).toFixed(4) }, '✅ TRANSAÇÃO CONFIRMADA COM SUCESSO! LUCRO OBTIDO!');
                                        tradeLog.status = 'completed';
                                        await tradeLog.save();
                                    }
                                } catch (e: any) {
                                    logger.warn({ txid: result.txid, error: e.message }, '⚠️ Timeout ou erro ao checar a confirmação da transação na rede.');
                                }
                            });

                        } else {
                            await FlashLoanTrade.deleteOne({ _id: tradeLog._id });
                            circuitBreaker.recordFailure();
                            logger.error({ txid: result.txid, jitoResponse: result.fullJitoResponse }, '❌ JITO REJEITOU O BUNDLE (Falha ao enviar)');
                        }
                    }
                } catch (txError: any) {
                    if (txError.message && txError.message.includes('encoding overruns Uint8Array')) {
                        logger.error('🚨 TRANSAÇÃO GIGANTE (> 1232 bytes) — ignorando oportunidade');
                    } else {
                        logger.error(`Erro na transação: ${txError.message}`);
                    }
                }
            }
        }
    } catch (err: any) {
        const status = err.response?.status || err.status;
        
        if (strategy.temporary && (status === 400 || status === 429)) {
            logger.warn(`Erro ${status} detectado na estratégia temporária ${strategy.name}. A estratégia será eliminada prematuramente.`);
            await DatabaseService.deleteStrategy(strategy._id.toString());
            temporaryAttempts.delete(strategy._id.toString());
            cachedStrategies = cachedStrategies.filter(s => s._id.toString() !== strategy._id.toString());
        }

        if (err.message && err.message.includes('Solend Pool configuration not found')) {
            logger.error(`Erro de Configuração de Pool: ${err.message}`);
        } else if (status === 429) {
            globalPenaltyMs = Date.now() + 15000;
            logger.warn('Rate Limit 429 detectado. Penalidade de 15s aplicada.');
        } else {
            logger.error(`Erro ignorado durante a busca de cotações: ${err.message || err}`);
        }
    }
}

async function runArbitrageCycle() {
    if (isAnalyzing || cachedStrategies.length === 0) return;
    const now = Date.now();
    if (globalPenaltyMs > now) return;

    isAnalyzing = true;
    try {
        process.stdout.write(`\r⚡ Analisando ${cachedStrategies.length} estratégia(s) via ciclo geral... | ${new Date().toLocaleTimeString()} `);
        await Promise.all(cachedStrategies.map(async (strategy) => {
            await runSingleStrategyArbitrage(strategy);
        }));
    } finally {
        isAnalyzing = false;
        process.stdout.write(` | Levou: ${Date.now() - now}ms`);
    }
}

async function triggerTargetedArbitrageCycle(mintA: string, mintB: string) {
    if (isAnalyzing || cachedStrategies.length === 0) return;
    const now = Date.now();
    if (globalPenaltyMs > now) return;

    isAnalyzing = true;
    try {
        const matchingStrategies = cachedStrategies.filter(strategy => {
            const tokenA = strategy.tokenAMint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
            const tokenB = strategy.tokenBMint;
            return (tokenA === mintA && tokenB === mintB) || (tokenA === mintB && tokenB === mintA);
        });

        if (matchingStrategies.length === 0) return;

        process.stdout.write(`\r⚡ Mudança em Pool detectada. Analisando ${matchingStrategies.length} estratégia(s)... | ${new Date().toLocaleTimeString()} `);
        await Promise.all(matchingStrategies.map(async (strategy) => {
            await runSingleStrategyArbitrage(strategy);
        }));
    } finally {
        isAnalyzing = false;
        process.stdout.write(` | Levou: ${Date.now() - now}ms`);
    }
}

async function pollTargetPoolAccounts() {
    if (isAnalyzing || cachedStrategies.length === 0) return;

    if (activeTargetPools.length === 0) {
        // Fallback para loop tradicional se não houver pools definidos
        await runArbitrageCycle();
        return;
    }

    try {
        const conn = await SolanaService.getConnection();
        const publicKeys = activeTargetPools.map(p => p.address);
        const accountsInfo = await conn.getMultipleAccountsInfo(publicKeys, 'confirmed');

        const changedPairs = new Set<string>();

        for (let i = 0; i < accountsInfo.length; i++) {
            const poolInfo = activeTargetPools[i];
            const accInfo = accountsInfo[i];
            const poolAddr = poolInfo.address.toBase58();

            const currentData = accInfo && accInfo.data ? accInfo.data.toString('base64') : '';
            const lastData = lastKnownPoolStates.get(poolAddr) || '';

            if (currentData !== lastData) {
                lastKnownPoolStates.set(poolAddr, currentData);
                const pairKey = [poolInfo.mintA, poolInfo.mintB].sort().join(':');
                changedPairs.add(pairKey);
            }
        }

        const now = Date.now();
        const hasStrategiesWithoutPools = cachedStrategies.some(s => getTargetPools(s.tokenAMint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', s.tokenBMint).length === 0);

        if (changedPairs.size > 0 || hasStrategiesWithoutPools) {
            if (globalPenaltyMs > now) return;

            isAnalyzing = true;
            try {
                process.stdout.write(`\r⚡ Mudança detectada via polling. Analisando ${cachedStrategies.length} estratégia(s)... | ${new Date().toLocaleTimeString()} `);
                await Promise.all(cachedStrategies.map(async (strategy) => {
                    const tokenA = strategy.tokenAMint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
                    const tokenB = strategy.tokenBMint;
                    const pools = getTargetPools(tokenA, tokenB);

                    if (pools.length === 0) {
                        const lastRun = lastStrategyRunTimes.get(strategy._id.toString()) || 0;
                        if (now - lastRun >= MIN_INTERVAL_MS) {
                            lastStrategyRunTimes.set(strategy._id.toString(), now);
                            await runSingleStrategyArbitrage(strategy);
                        }
                    } else {
                        const strategyKey = [tokenA, tokenB].sort().join(':');
                        if (changedPairs.has(strategyKey)) {
                            await runSingleStrategyArbitrage(strategy);
                        }
                    }
                }));
            } finally {
                isAnalyzing = false;
                process.stdout.write(` | Levou: ${Date.now() - now}ms`);
            }
        }
    } catch (error) {
        console.error('Erro ao pesquisar contas dos pools:', error);
    }
}

let engineIntervalId: NodeJS.Timeout | null = null;
let wssSubscriptionId: number | null = null;
let wssConnectionInstance: any = null;

async function restartExecutionEngine() {
    if (engineIntervalId) {
        clearInterval(engineIntervalId);
        engineIntervalId = null;
    }
    if (wssSubscriptionId !== null && wssConnectionInstance) {
        try {
            await wssConnectionInstance.removeSlotChangeListener(wssSubscriptionId);
        } catch(e) {}
        wssSubscriptionId = null;
    }
    if (targetPoolSubscriptionIds.length > 0 && wssConnectionInstance) {
        for (const subId of targetPoolSubscriptionIds) {
            try {
                await wssConnectionInstance.removeAccountChangeListener(subId);
            } catch (e) {}
        }
        targetPoolSubscriptionIds = [];
    }

    if (connectionMode === 'wss') {
        console.log(`\n🔌 Motor WSS ativado (Subscrevendo a eventos de slot e pool accounts).`);
        try {
            wssConnectionInstance = await SolanaService.getWssConnection();

            await resubscribePoolAccounts();

            wssSubscriptionId = wssConnectionInstance.onSlotChange((slot: any) => {
                if (cachedStrategies.length > 0) {
                    const hasStrategiesWithoutPools = cachedStrategies.some(s => getTargetPools(s.tokenAMint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', s.tokenBMint).length === 0);
                    if (hasStrategiesWithoutPools) {
                        runArbitrageCycle().catch(err => {
                            console.error('\n❌ Erro no ciclo WSS (Slot):', err);
                        });
                    }
                }
            });
        } catch (error) {
            console.error("❌ Falha ao ativar WSS, voltando para RPC.", error);
            connectionMode = 'rpc';
            restartExecutionEngine();
        }
    } else {
        console.log(`\n🔌 Motor RPC ativado (Polling de pools a cada ${FAST_POLL_INTERVAL_MS}ms).`);
        engineIntervalId = setInterval(() => {
            if (cachedStrategies.length > 0) {
                pollTargetPoolAccounts().catch(err => {
                    console.error('\n❌ Erro no polling RPC de pools:', err);
                });
            }
        }, FAST_POLL_INTERVAL_MS);
    }
}

async function checkPendingTransactions() {
    try {
        const pendingTrades = await FlashLoanTrade.find({ status: 'pending', txid: { $exists: true, $ne: null } });
        if (pendingTrades.length === 0) return;

        const conn = await SolanaService.getConnection();
        
        for (const trade of pendingTrades) {
            try {
                const signatureStatus = await conn.getSignatureStatus(trade.txid);
                
                if (signatureStatus && signatureStatus.value) {
                    if (signatureStatus.value.err) {
                        logger.error({ txid: trade.txid, err: signatureStatus.value.err }, '❌ TRANSAÇÃO FALHOU NA REDE (Poller)');
                        await FlashLoanTrade.deleteOne({ _id: trade._id });
                    } else if (signatureStatus.value.confirmationStatus === 'confirmed' || signatureStatus.value.confirmationStatus === 'finalized') {
                        logger.info({ txid: trade.txid, profitUsdc: trade.expectedProfit }, '✅ TRANSAÇÃO CONFIRMADA COM SUCESSO! LUCRO OBTIDO! (Poller)');
                        trade.status = 'completed';
                        await trade.save();
                    }
                }
            } catch (err) {
                console.error(`Erro ao checar transação pendente ${trade.txid}:`, err);
            }
        }
    } catch (err) {
        console.error('Erro no poller de transações pendentes:', err);
    }
}

async function startEngine() {
    console.log('\n=============================================');
    console.log('🚀 INICIANDO MOTOR DE ARBITRAGEM (V2 - WS/SOLID)');
    console.log('=============================================\n');

    try {
        await DatabaseService.connect();

        // Poller Rápido (3 segundos) para respostas imediatas ao ligar/desligar estratégias no dashboard
        setInterval(async () => {
            try {
                const status = await DatabaseService.updateHeartbeatAndGetStatus();
                
                if (status.botMode !== botMode) {
                     botMode = status.botMode;
                     console.log(`\n⚙️ Modo do Bot alterado para: ${botMode}`);
                }

                if (status.connectionMode !== connectionMode) {
                     connectionMode = status.connectionMode;
                     console.log(`\n⚙️ Modo de Conexão alterado para: ${connectionMode}. Reiniciando motor...`);
                     restartExecutionEngine();
                }

                await reloadState();
            } catch (err) {
                console.error('Erro no poller rápido:', err);
            }
        }, 3000);

        // Poller Médio (15 segundos) para atualizar preços e taxas de rede (evita rate limits)
        setInterval(async () => {
            try {
                latestJitoTipLamports = await SolanaService.getDynamicJitoTip();
                cachedSolPriceUsdc = await QuoteService.fetchSolPriceUsdc();
            } catch (err) {
                console.error('Erro no poller de preços:', err);
            }
        }, 15000);

        await restartExecutionEngine();

    } catch (err) {
        console.error('❌ Falha ao iniciar:', err);
        process.exit(1);
    }
}

startEngine();
