import { Keypair, PublicKey } from '@solana/web3.js';
import { DatabaseService } from '../../services/DatabaseService';
import { QuoteService } from '../../services/QuoteService';
import { SolanaService } from '../../services/SolanaService';
import { TransactionBuilder } from '../../services/TransactionBuilder';
import { borrowFlashLoanFromSolend, repayFlashLoanToSolend } from './solend-helper';
import { borrowFlashLoanFromKamino, repayFlashLoanToKamino } from './kamino-helper';
import { getSolendPoolConfig } from '../../config/solend-pools';
import { getKaminoPoolConfig } from '../../config/kamino-pools';
import FlashLoanTrade from '../../../models/FlashLoanTrade';
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

async function reloadState() {
    cachedStrategies = await DatabaseService.getActiveStrategies();
    if (cachedStrategies.length > 0) {
        userIdCache = cachedStrategies[0].userId.toString();

        const USDC_MINT_PK = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
        const conn = await SolanaService.getConnection();

        const uniqueWalletIds = [...new Set(cachedStrategies.map(s => s.walletId?.toString()).filter(Boolean))];

        for (const walletId of uniqueWalletIds) {
            if (!walletCache.has(walletId)) {
                const keypair = await DatabaseService.getWalletForUser(userIdCache!); // Temporary fix
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
    }
}

async function runArbitrageCycle() {
    if (isAnalyzing || cachedStrategies.length === 0) return;
    const now = Date.now();
    if (globalPenaltyMs > now || now - lastExecutionTime < MIN_INTERVAL_MS) return;

    isAnalyzing = true;
    lastExecutionTime = now;

    try {
        process.stdout.write(`\r⚡ Slot atualizado. Analisando ${cachedStrategies.length} estratégia(s)... | Última checagem: ${new Date().toLocaleTimeString()} `);
        await Promise.all(cachedStrategies.map(async (strategy) => {
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
                const lendingProvider = strategy.lendingProvider || 'solend';

                let poolConfig;
                if (lendingProvider === 'kamino') {
                    poolConfig = getKaminoPoolConfig(tokenBorrowed);
                } else {
                    poolConfig = getSolendPoolConfig(tokenBorrowed);
                }

                const BORROW_AMOUNT = Math.floor(strategy.borrowAmount * 1e6);
                const useRaptor = strategy.provider === 'raptor';

                const quotes = await QuoteService.getQuotes(strategy.tokenBMint, BORROW_AMOUNT, useRaptor);
                if (!quotes) return;

                const { quoteA, quoteB } = quotes;
                const flashLoanFee = Math.ceil((BORROW_AMOUNT * 9) / 10000); // 0.09% varies by pool in reality

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
                                executionWallet.usdcAta,
                                poolConfig,
                                lendingProvider
                            );

                            if (result) {
                                tradeLog.txid = result.txid;
                                tradeLog.gasFee = latestJitoTipLamports / 1e9;
                                if (result.jitoBundleId) {
                                    tradeLog.jitoBundleId = result.jitoBundleId;
                                    await tradeLog.save();
                                } else {
                                    tradeLog.status = 'failed';
                                    tradeLog.errorMessage = 'Jito rejeitou o bundle';
                                    await tradeLog.save();
                                    circuitBreaker.recordFailure();
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
        }));
    } finally {
        isAnalyzing = false;
        process.stdout.write(` | Levou: ${Date.now() - now}ms`);
    }
}

let engineIntervalId: NodeJS.Timeout | null = null;
let wssSubscriptionId: number | null = null;
let wssConnectionInstance: any = null;

async function restartExecutionEngine() {
    // Limpa execuções atuais
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

    if (connectionMode === 'wss') {
        console.log(`\n🔌 Motor WSS ativado (Subscrevendo a eventos de slot).`);
        try {
            wssConnectionInstance = await SolanaService.getWssConnection();
            wssSubscriptionId = wssConnectionInstance.onSlotChange((slot: any) => {
                if (cachedStrategies.length > 0) {
                    runArbitrageCycle().catch(err => {
                        console.error('\n❌ Erro no ciclo WSS:', err);
                    });
                }
            });
        } catch (error) {
            console.error("❌ Falha ao ativar WSS, voltando para RPC.", error);
            connectionMode = 'rpc';
            restartExecutionEngine();
        }
    } else {
        console.log(`\n🔌 Motor RPC ativado (Polling a cada ${MIN_INTERVAL_MS}ms).`);
        engineIntervalId = setInterval(() => {
            if (cachedStrategies.length > 0) {
                runArbitrageCycle().catch(err => {
                    console.error('\n❌ Erro no ciclo RPC:', err);
                });
            }
        }, MIN_INTERVAL_MS);
    }
}

async function startEngine() {
    console.log('\n=============================================');
    console.log('🚀 INICIANDO MOTOR DE ARBITRAGEM (V2 - WS/SOLID)');
    console.log('=============================================\n');

    try {
        await DatabaseService.connect();

        // Initial Fetch for botMode and State
        const status = await DatabaseService.updateHeartbeatAndGetStatus();
        botMode = status.botMode;
        connectionMode = status.connectionMode;

        await reloadState();

        // Heartbeat & Status fetch
        setInterval(async () => {
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

            latestJitoTipLamports = await SolanaService.getDynamicJitoTip();
            cachedSolPriceUsdc = await QuoteService.fetchSolPriceUsdc();
            await reloadState();
        }, 15000);

        await restartExecutionEngine();

    } catch (err) {
        console.error('❌ Falha ao iniciar:', err);
        process.exit(1);
    }
}

startEngine();
