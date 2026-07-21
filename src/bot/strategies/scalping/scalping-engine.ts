import { DatabaseService } from '../../services/DatabaseService';
import ScalpingStrategy from '../../../models/ScalpingStrategy';
import ScalpingTrade from '../../../models/ScalpingTrade';
import BotStatus from '../../../models/BotStatus';
import { decryptSecretKey } from '../../../utils/encryption';
import * as ccxt from 'ccxt';
import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({
    level: 'debug',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
            messageFormat: '{msg}'
        }
    }
});

let activeStrategies: any[] = [];
let isRunning = false;
const runningLoops: Record<string, boolean> = {}; // Mapeia o ID da estratégia para saber se ela já está rodando

// Cache ccxt.pro instances by ExchangeKey ID
const exchangeInstances: Record<string, ccxt.Exchange> = {};
const cachedBalances: Record<string, any> = {};

const redisUrl = process.env.REDIS_URL;
export const redisClient = redisUrl ? new Redis(redisUrl) : null;

async function updateCachedBalance(keyId: string, balance: any) {
    cachedBalances[keyId] = balance;
    if (redisClient) {
        redisClient.hset('hft:balances', keyId, JSON.stringify(balance)).catch(e => logger.error(`Erro Redis hset balances: ${e.message}`));
    }
}

// Stateful memory of open positions
type OpenPosition = {
    tradeId: string;
    entryPrice: number;
    entryTime: number;
    amount: number;
    side: 'buy' | 'sell';
    limitSellOrderId?: string;
    status: 'entry_pending' | 'in_position';
    limitBuyOrderId?: string;
    highestPriceReached?: number;
    trailingActive?: boolean;
    breakEvenActive?: boolean;
};
const positions: Record<string, OpenPosition> = {};

async function setPosition(stratId: string, pos: OpenPosition) {
    positions[stratId] = pos;
    if (redisClient) {
        redisClient.hset('hft:positions', stratId, JSON.stringify(pos)).catch(e => logger.error(`Erro Redis hset pos: ${e.message}`));
    }
}

async function removePosition(stratId: string) {
    delete positions[stratId];
    if (redisClient) {
        redisClient.hdel('hft:positions', stratId).catch(e => logger.error(`Erro Redis hdel pos: ${e.message}`));
    }
}

type TrendData = {
    isUptrend: boolean;
    ema9: number;
    ema21: number;
    rsi: number;
    vwap: number;
    atr: number;
    lastUpdate: number;
    spreadPct?: number;
    orderBookImbalance?: number;
    priceAction?: {
        recentResistance: number;
        distanceToResistancePct: number;
    };
};
const trends: Record<string, TrendData> = {};
const cooldowns: Record<string, number> = {};

// Circuit Breaker: Daily Loss Tracking
const dailyLossUsd: Record<string, number> = {};
const dailyLossResetTime: Record<string, number> = {};

function checkAndResetDailyLoss(userId: string) {
    const now = Date.now();
    const lastReset = dailyLossResetTime[userId] || 0;
    const midnightToday = new Date();
    midnightToday.setHours(0, 0, 0, 0);
    if (lastReset < midnightToday.getTime()) {
        dailyLossUsd[userId] = 0;
        dailyLossResetTime[userId] = now;
        logger.info(`🔄 [CIRCUIT BREAKER] Contador de perda diária resetado para userId: ${userId}`);
    }
}

function accumulateDailyLoss(userId: string, lossUsd: number) {
    checkAndResetDailyLoss(userId);
    dailyLossUsd[userId] = (dailyLossUsd[userId] || 0) + lossUsd;
    logger.warn(`⚠️ [CIRCUIT BREAKER] Perda acumulada no dia: $${dailyLossUsd[userId].toFixed(2)}`);
}

function isDailyLossBreached(strategy: any): boolean {
    if (!strategy.dailyLossLimit || strategy.dailyLossLimit <= 0) return false;
    const userId = strategy.userId?.toString();
    if (!userId) return false;
    checkAndResetDailyLoss(userId);
    const currentLoss = dailyLossUsd[userId] || 0;
    if (currentLoss >= strategy.dailyLossLimit) {
        logger.warn(`🛑 [CIRCUIT BREAKER] Limite diário de $${strategy.dailyLossLimit} atingido! Perda acumulada: $${currentLoss.toFixed(2)}. Motor pausado para ${strategy.name}.`);
        return true;
    }
    return false;
}

// EMA Math Helper
function calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] || 0;
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
        ema = (prices[i] * k) + (ema * (1 - k));
    }
    return ema;
}

// RSI Math Helper
function calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length <= period) return 50; // Retorno neutro se não houver velas suficientes
    let gains = 0;
    let losses = 0;

    // Primeira média móvel
    for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Suavização Welles Wilder
    for (let i = period + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff >= 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - diff) / period;
        }
    }

    if (avgLoss === 0) return 100; // Alta infinita
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// VWAP Math Helper
function calculateVWAP(ohlcv: any[][]): number {
    let cumulativeTypicalPriceVolume = 0;
    let cumulativeVolume = 0;
    for (const candle of ohlcv) {
        const high = Number(candle[2]);
        const low = Number(candle[3]);
        const close = Number(candle[4]);
        const volume = Number(candle[5]);
        if (isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume)) continue;
        const typicalPrice = (high + low + close) / 3;
        cumulativeTypicalPriceVolume += typicalPrice * volume;
        cumulativeVolume += volume;
    }
    return cumulativeVolume === 0 ? 0 : cumulativeTypicalPriceVolume / cumulativeVolume;
}

// ATR Math Helper
function calculateATR(ohlcv: any[][], period: number = 14): number {
    if (ohlcv.length <= period) return 0;
    const trValues: number[] = [];
    
    for (let i = 1; i < ohlcv.length; i++) {
        const high = Number(ohlcv[i][2]);
        const low = Number(ohlcv[i][3]);
        const prevClose = Number(ohlcv[i-1][4]);
        if (isNaN(high) || isNaN(low) || isNaN(prevClose)) continue;
        
        const tr1 = high - low;
        const tr2 = Math.abs(high - prevClose);
        const tr3 = Math.abs(low - prevClose);
        const tr = Math.max(tr1, tr2, tr3);
        trValues.push(tr);
    }
    
    if (trValues.length < period) return 0;
    let trSum = 0;
    for (let i = 0; i < period; i++) {
        trSum += trValues[i];
    }
    let atr = trSum / period;
    
    for (let i = period; i < trValues.length; i++) {
        atr = ((atr * (period - 1)) + trValues[i]) / period;
    }
    return atr;
}

async function fetchActiveStrategies() {
    activeStrategies = await ScalpingStrategy.find({}).populate('exchangeKeyId');
}

async function getOrCreateExchangeInstance(exchangeKeyDoc: any) {
    const keyIdStr = exchangeKeyDoc._id.toString();
    if (exchangeInstances[keyIdStr]) {
        return exchangeInstances[keyIdStr];
    }

    const { exchangeId, apiKey, apiSecret, userId } = exchangeKeyDoc;
    const authContext = `${userId}-${exchangeId}`;
    let decryptedSecret = '';

    try {
        decryptedSecret = decryptSecretKey(apiSecret, authContext);
    } catch (err: any) {
        logger.error(`Falha ao decriptar chave da API para ${exchangeId}. A chave pode estar corrompida ou o ENCRYPTION_KEY está incorreto.`);
        return null;
    }

    // Mapeamento de nomes internos do DB para os IDs corretos do CCXT
    let ccxtExchangeId = exchangeId;
    if (ccxtExchangeId === 'gateio') ccxtExchangeId = 'gate';

    if ((ccxt as any).pro[ccxtExchangeId]) {
        const ExchangeClass = (ccxt as any).pro[ccxtExchangeId] as any;
        const instance = new ExchangeClass({
            apiKey: apiKey,
            secret: decryptedSecret,
            enableRateLimit: false, // DESLIGADO PARA HFT: A trava padrão do CCXT estava enfileirando as ordens e gerando delay de 3 segundos
            options: {
                adjustForTimeDifference: true,
                recvWindow: 5000,
            }
        });

        exchangeInstances[keyIdStr] = instance;
        logger.info(`Conexão WebSocket com a CEX ${exchangeId.toUpperCase()} iniciada com sucesso.`);

        try {
            logger.info(`Buscando saldo inicial para ${exchangeId.toUpperCase()}...`);
            const initialBalance = await instance.fetchBalance();
            await updateCachedBalance(keyIdStr, initialBalance);
        } catch (e: any) {
            logger.warn(`Aviso: Falha ao buscar saldo inicial na CEX ${exchangeId.toUpperCase()}: ${e.message}`);
        }

        return instance;
    } else {
        logger.error(`Exchange ${exchangeId} não suporta WebSockets (Pro) nativamente no CCXT.`);
        return null;
    }
}

async function processTick(ticker: ccxt.Ticker, strategy: any, exchange: ccxt.Exchange) {
    const tickStart = performance.now();
    let currentPrice = ticker.last;
    if (!currentPrice) {
        // MEXC e outras CEX enviam BBO (Best Bid/Offer) no ticker sem o last trade
        // Para HFT, usamos o mid-price se o last não estiver disponível
        if (ticker.bid && ticker.ask) {
            currentPrice = (ticker.bid + ticker.ask) / 2;
        } else {
            return;
        }
    }

    const stratId = strategy._id.toString();
    const position = positions[stratId];
    // Timeout de segurança para evitar que o robô trave se a exchange não responder
    if ((strategy as any).isProcessingTrade) {
        const processingSince = (strategy as any).processingSince || 0;
        if (Date.now() - processingSince > 2000) {
            logger.warn(`[DEBUG] Resetando isProcessingTrade travado há mais de 2s para ${strategy.name}`);
            (strategy as any).isProcessingTrade = false;
        } else {
            return;
        }
    }

    // --- BLOCO DE CHECAGEM DE ENTRADA MAKER ---
    if (position && position.status === 'entry_pending') {
        if (!position.limitBuyOrderId) return;
        
        try {
            const fetchedOrder = await exchange.fetchOrder(position.limitBuyOrderId, strategy.symbol);
            if (fetchedOrder.status === 'closed') {
                position.status = 'in_position';
                position.entryPrice = fetchedOrder.average || fetchedOrder.price || position.entryPrice;
                position.entryTime = Date.now();
                position.amount = fetchedOrder.filled || position.amount;
                
                // Salvar no DB apenas quando a ordem efetivamente for preenchida!
                if (!position.tradeId) {
                    const tradeDoc = await ScalpingTrade.create({
                        userId: strategy.userId,
                        strategyId: strategy._id,
                        type: 'buy',
                        symbol: strategy.symbol,
                        price: position.entryPrice,
                        entryPrice: position.entryPrice,
                        amount: position.amount,
                        status: 'in_position',
                        entryTxid: position.limitBuyOrderId,
                        entryTime: new Date(position.entryTime)
                    });
                    position.tradeId = tradeDoc._id.toString();
                } else {
                    await ScalpingTrade.findByIdAndUpdate(position.tradeId, { 
                        status: 'in_position', 
                        entryPrice: position.entryPrice,
                        amount: position.amount,
                        entryTime: new Date(position.entryTime)
                    });
                }
                
                logger.info(`✅ [MAKER FILL] Ordem Limit Buy preenchida a $${position.entryPrice.toFixed(4)}. ID: ${position.tradeId}`);
                await setPosition(stratId, position); // Sync updated state to Redis
            } else if (fetchedOrder.status === 'open') {
                const elapsed = Date.now() - position.entryTime;
                if (elapsed > 10000) { // 10 segundos de timeout (Reprecificação Adaptativa)
                    logger.info(`⏳ Ordem Maker Entry (${position.limitBuyOrderId}) expirou após 10s. Cancelando para reposicionar...`);
                    try {
                        await exchange.cancelOrder(position.limitBuyOrderId, strategy.symbol);
                    } catch (cancelErr) {
                        logger.debug('Ordem já estava cancelada ou fechada ao tentar cancelar no timeout.');
                    }
                    
                    // TRATAMENTO DE COMPRA PARCIAL
                    if (fetchedOrder.filled && fetchedOrder.filled > 0) {
                        logger.warn(`⚠️ [COMPRA PARCIAL] A ordem não foi 100% preenchida, mas conseguimos ${fetchedOrder.filled}. Assumindo a posição parcial!`);
                        position.status = 'in_position';
                        position.entryPrice = fetchedOrder.average || fetchedOrder.price || position.entryPrice;
                        position.entryTime = Date.now();
                        position.amount = fetchedOrder.filled;
                        
                        if (!position.tradeId) {
                            const tradeDoc = await ScalpingTrade.create({
                                userId: strategy.userId,
                                strategyId: strategy._id,
                                type: 'buy',
                                symbol: strategy.symbol,
                                price: position.entryPrice,
                                entryPrice: position.entryPrice,
                                amount: position.amount,
                                status: 'in_position',
                                entryTxid: position.limitBuyOrderId,
                                entryTime: new Date(position.entryTime),
                                errorMessage: 'Preenchimento Parcial (Timeout 10s)'
                            });
                            position.tradeId = tradeDoc._id.toString();
                        } else {
                            await ScalpingTrade.findByIdAndUpdate(position.tradeId, { 
                                status: 'in_position', 
                                entryPrice: position.entryPrice,
                                amount: position.amount,
                                errorMessage: 'Preenchimento Parcial (Timeout 10s)',
                                entryTime: new Date(position.entryTime)
                            });
                        }
                        await setPosition(stratId, position); // Sync partial fill state to Redis
                    } else {
                        if (position.tradeId) await ScalpingTrade.findByIdAndUpdate(position.tradeId, { status: 'failed', errorMessage: 'Entry timeout (Zero fill)' });
                        await removePosition(stratId);
                    }
                }
            } else if (fetchedOrder.status === 'canceled' || fetchedOrder.status === 'rejected') {
                if (position.tradeId) await ScalpingTrade.findByIdAndUpdate(position.tradeId, { status: 'failed', errorMessage: 'Ordem de entrada cancelada' });
                await removePosition(stratId);
            }
        } catch (e: any) {
            logger.debug(`Aviso: erro ao checar status da Maker Entry: ${e.message}`);
        }
        return; // Se tem posição pendente, abortamos o resto do tick até resolver a entrada
    }

    // Se NÃO tem posição aberta, EXECUTAR a ENTRADA (Compra real ao mercado)
    if (!position) {
        // Se a estratégia foi pausada pelo usuário, nós apenas observamos, não compramos
        if (!strategy.active) {
            return;
        }

        // Circuit Breaker: verificar limite de perda diária antes de qualquer nova entrada
        if (isDailyLossBreached(strategy)) {
            return;
        }

        // Checar se a estratégia está em cooldown devido a algum erro da API
        if ((strategy as any).cooldownUntil && Date.now() < (strategy as any).cooldownUntil) {
            return;
        }

        // --- NOVO: FILTRO DE TENDÊNCIA E RSI ---
        const trend = trends[stratId];

        // --- NOVO: FILTRO DE SPREAD ---
        let currentSpread = 0;
        if (ticker.bid && ticker.ask) {
            currentSpread = ((ticker.ask - ticker.bid) / ticker.bid) * 100;
        } else if (trend && trend.spreadPct !== undefined) {
            currentSpread = trend.spreadPct;
        } else {
            // Sem visibilidade do spread, abortamos para segurança
            return;
        }

        const maxAllowedSpread = strategy.maxSpreadPercentage !== undefined ? strategy.maxSpreadPercentage : Math.min(strategy.stopLossPercentage, strategy.takeProfitPercentage);
        if (currentSpread >= maxAllowedSpread) {
            // Se o spread for maior que o permitido, o trade é matematicamente inviável
            return; 
        }

        if (!trend || !trend.isUptrend) {
            // Ignora o tick se o mercado não estiver validado como Tendência de Alta
            return;
        }

        if (trend.ema9 && currentPrice < trend.ema9) {
            // Filtro Faca Caindo: A média móvel é "atrasada". Se derreter uma vela gigante vermelha, 
            // a EMA9 ainda demora a cair. Esse filtro bloqueia a compra se o preço atual já estiver 
            // abaixo da EMA9, evitando comprar no meio de um dump.
            return;
        }

        if (trend.rsi >= 70) {
            // Ignora o tick se o ativo estiver esticado/sobrecomprado (risco de queda iminente)
            return;
        }
        if (trend.vwap && currentPrice < trend.vwap) {
            // Segurança: Só comprar se o preço estiver acima da VWAP (tendência compradora validada pelo volume)
            return;
        }

        // --- NOVO: PRICE ACTION (Resistência) ---
        if (trend.priceAction) {
            // Se estivermos muito perto de uma resistência recente (ex: a menos de 0.05% do topo das últimas 30 velas)
            // Aborta a compra para evitar comprar exatamente no topo e sofrer rejeição imediata.
            if (trend.priceAction.distanceToResistancePct > 0 && trend.priceAction.distanceToResistancePct < 0.05) {
                return; 
            }
        }

        // --- NOVO: Order Book Imbalance (Pressão Institucional) ---
        if (trend.orderBookImbalance && trend.orderBookImbalance > 2.5) {
            // Se tiver 2.5x mais peso de Venda no Livro, aborta! Tem muralha de venda (Spoofing) esmagando a cotação.
            return;
        }

        (strategy as any).isProcessingTrade = true;
        (strategy as any).processingSince = Date.now();
        try {
            // --- BLOCO DE NOVA ENTRADA ---
            if (!position) {
                if (strategy.isPaused) {
                    // Robô está em modo de "Desligamento Gracioso". Ele não entra mais, apenas aguarda zerar posições.
                    return; 
                }

                if (cooldowns[stratId] && Date.now() < cooldowns[stratId]) {
                    // Robô está em cooldown anti-violinada (esperando a poeira baixar)
                    (strategy as any).isProcessingTrade = false;
                    return;
                }

                const quoteAsset = strategy.symbol.split('/')[1];
                const keyIdStr = strategy.exchangeKeyId._id.toString();
                const balance = cachedBalances[keyIdStr];

                if (!balance) {
                    (strategy as any).isProcessingTrade = false;
                    return;
                }

                const quoteBalance = (balance?.free as any)?.[quoteAsset] ?? 0;
                const estimatedCost = strategy.tradeSize; 

                // Validação Silenciosa: Se não tem saldo, sequer cogitamos entrar ou anunciamos. O bot ignora a oportunidade.
                if (quoteBalance < estimatedCost * 1.05) {
                    (strategy as any).isProcessingTrade = false;
                    return;
                }

                logger.info(`🟢 [INICIANDO ENTRADA] HFT Scalper (${strategy.name}) detectou oportunidade e validou o saldo livre ($${quoteBalance.toFixed(2)}). Armando bote...`);

            // Converter o valor em dólares (USDC) para a quantidade da moeda (SOL)
            const baseAmount = strategy.tradeSize / currentPrice;

            // 2. Precisão da ordem
            let formattedAmount = baseAmount;
            if (exchange.amountToPrecision) {
                formattedAmount = Number(exchange.amountToPrecision(strategy.symbol, baseAmount));
            }

            // 3. Execução Real
            // Modificado para Maker Entry (pescando no bid)
            const limitBuyPrice = ticker.bid || currentPrice;
            
            // Distributed Lock: Tentar reservar a posição no Redis primeiro
            const lockPos = {
                tradeId: '',
                entryPrice: limitBuyPrice,
                entryTime: Date.now(),
                amount: formattedAmount,
                side: 'buy' as const,
                status: 'entry_pending' as const
            };
            
            if (redisClient) {
                const acquired = await redisClient.hsetnx('hft:positions', stratId, JSON.stringify(lockPos));
                if (acquired === 0) {
                    logger.warn(`⚠️ [LOCK] Outra instância já iniciou entrada para ${strategy.name}. Abortando duplicidade.`);
                    (strategy as any).isProcessingTrade = false;
                    return;
                }
            }

            logger.info(`🚀 HFT MAKER ATIVADO: Pendurando Limit Buy (Post-Only) de ${formattedAmount} ${strategy.symbol.split('/')[0]} a $${limitBuyPrice.toFixed(4)}...`);
            
            try {
                const apiStart = performance.now();
                const order = await exchange.createLimitBuyOrder(strategy.symbol, formattedAmount, limitBuyPrice, { postOnly: true });
                const apiEnd = performance.now();
                logger.debug(`⚡ [LATÊNCIA CIRÚRGICA API] Disparo da ordem para a Exchange levou ${(apiEnd - apiStart).toFixed(2)}ms`);

                // Subtrair otimisticamente do saldo em memória para evitar que o próximo tick compre novamente antes do update de 15s
                if (cachedBalances[keyIdStr]?.free?.[quoteAsset]) {
                    (cachedBalances[keyIdStr].free as any)[quoteAsset] -= estimatedCost;
                    updateCachedBalance(keyIdStr, cachedBalances[keyIdStr]);
                }

                // 4. Salvar apenas em memória como intenção (pendente) para evitar lixo no DB
                const finalPos = { ...lockPos, limitBuyOrderId: order.id || order.info?.id || order.clientOrderId };
                if (!finalPos.limitBuyOrderId) {
                    logger.error(`❌ [LOCK] Corretora não retornou ID da ordem para ${strategy.name}. Liberando lock.`);
                    if (redisClient) await redisClient.hdel('hft:positions', stratId);
                    throw new Error('Ordem sem ID retornada pela corretora.');
                }
                await setPosition(stratId, finalPos);

                logger.info(`✅ [INTENÇÃO REGISTRADA] Ordem Limit aguardando fill a $${limitBuyPrice.toFixed(4)}.`);
            } catch (err: any) {
                if (redisClient) await redisClient.hdel('hft:positions', stratId); // Liberar o lock em caso de erro na CEX
                throw err;
            }
            }
        } catch (err: any) {
            logger.error(`❌ Falha ao tentar registrar intenção de Maker para ${strategy.name}: ${err.message}`);
            
            // Tratamento sugerido para erro 30004 / Insufficient position
            if (err.message && (err.message.includes('30004') || err.message.includes('Insufficient position'))) {
                logger.warn(`🔄 [SYNC] Erro de saldo fantasma. Sincronizando saldo com a Exchange e aplicando cooldown de 5s...`);
                try {
                    const keyIdStr = strategy.exchangeKeyId._id.toString();
                    const quoteAsset = strategy.symbol.split('/')[1];
                    const newBalance = await exchange.fetchBalance();
                    await updateCachedBalance(keyIdStr, newBalance);
                    logger.info(`✅ [SYNC] Saldo de ${quoteAsset} atualizado para $${(newBalance?.free as any)?.[quoteAsset] ?? 0}`);
                } catch (syncErr: any) {
                    logger.error(`Falha ao ressincronizar saldo: ${syncErr.message}`);
                }
                (strategy as any).cooldownUntil = Date.now() + 5000; // Cooldown de 5s
            }
        } finally {
            (strategy as any).isProcessingTrade = false;
        }
        const tickEnd = performance.now();
        logger.debug(`⏱️ [LATÊNCIA DE ENTRADA] O processamento completo de entrada levou ${(tickEnd - tickStart).toFixed(2)}ms`);
        return;
    }

    // Se TEM posição aberta E preenchida (in_position), verificar as condições de SAÍDA
    if (position && position.status === 'in_position') {
        const timeElapsedMs = Date.now() - position.entryTime;
    
    // Calcula o PnL REAL se fôssemos sair a mercado AGORA (vendendo no Bid)
    const currentExitPrice = ticker.bid || currentPrice;
    const realPnL = ((currentExitPrice - position.entryPrice) / position.entryPrice) * 100;

    let shouldExit = false;
    let exitReason = '';

    // Calcular o Spread atual
    let currentSpread = 0;
    const trend = trends[stratId];
    if (ticker.bid && ticker.ask) {
        currentSpread = ((ticker.ask - ticker.bid) / ticker.bid) * 100;
    } else if (trend && trend.spreadPct !== undefined) {
        currentSpread = trend.spreadPct;
    }

    // --- NOVO: Take Profit Dinâmico (Esticador de Alvo via ATR) ---
    let dynamicTakeProfitPct = strategy.takeProfitPercentage;
    if (trend && trend.atr && position.entryPrice) {
        const atrPct = (trend.atr / position.entryPrice) * 100;
        // Se a volatilidade (ATR) for maior que o TP original, a gente afasta o alvo para maximizar lucro
        // Limitando a um aumento máximo de 2.0x o TP original para não ficar ganancioso demais
        dynamicTakeProfitPct = Math.max(strategy.takeProfitPercentage, Math.min(strategy.takeProfitPercentage * 2.0, atrPct * 1.5));
    }

    const trailingDropTolerance = dynamicTakeProfitPct * 0.4;

    // Atualiza o rastreamento do preço máximo (pico) para o Trailing Stop
    let newPeak = false;
    if (!position.highestPriceReached || currentExitPrice > position.highestPriceReached) {
        position.highestPriceReached = currentExitPrice;
        newPeak = true;
    }
    const drawdownFromPeakPct = ((position.highestPriceReached - currentExitPrice) / position.highestPriceReached) * 100;

    // 1. Condição de Take Profit via Trailing Stop
    // Ativa a proteção quando o alvo inicial é batido
    if (realPnL >= dynamicTakeProfitPct && !position.trailingActive) {
        position.trailingActive = true;
        const exitTriggerPrice = position.highestPriceReached * (1 - (trailingDropTolerance / 100));
        logger.info(`🔥 [TRAILING ATIVADO] Meta Dinâmica de +${dynamicTakeProfitPct.toFixed(4)}% atingida (PnL Atual: +${realPnL.toFixed(4)}%). Alvo em $${exitTriggerPrice.toFixed(4)}`);
    } else if (position.trailingActive && newPeak) {
        const exitTriggerPrice = position.highestPriceReached * (1 - (trailingDropTolerance / 100));
        logger.info(`📈 [TRAILING ATUALIZADO] Novo pico alcançado ($${position.highestPriceReached.toFixed(4)}). Alvo de saída de segurança subiu para $${exitTriggerPrice.toFixed(4)}`);
    }

    if (position.trailingActive) {
        // Tolerância de recuo a partir do pico máximo atingido (ex: 40% da meta de TP)
        // Se a meta for 0.06%, o robô aguenta um recuo de 0.024% a partir do topo antes de vender.
        if (drawdownFromPeakPct >= trailingDropTolerance) {
            shouldExit = true;
            exitReason = 'TRAILING_STOP_PROFIT';
        }
    }

    // --- NOVO: Break-Even Stop (Ativação) ---
    if (!position.trailingActive && !position.breakEvenActive && realPnL >= (dynamicTakeProfitPct * 0.5)) {
        position.breakEvenActive = true;
        logger.info(`🛡️ [BREAK-EVEN ATIVADO] PnL bateu +${realPnL.toFixed(4)}% (Metade do Alvo Dinâmico na CEX). Risco zerado!`);
    }

    // 2. Condição de Stop Loss Dinâmico
    if (!shouldExit && !position.trailingActive) {
        let dynamicStopLossPct = strategy.stopLossPercentage;
        if (trend && trend.atr && position.entryPrice) {
            const atrPct = (trend.atr / position.entryPrice) * 100;
            const absoluteFloor = Math.max(0.05, (strategy.maxSpreadPercentage || 0.05));
            dynamicStopLossPct = Math.max(absoluteFloor, Math.min(strategy.stopLossPercentage, atrPct * 3.0));
        }

        // --- NOVO: Time-Decay Stop (Encolhimento do Stop por Tempo) ---
        const timeRatio = Math.min(1.0, timeElapsedMs / strategy.maxPositionTimeMs);
        if (timeRatio > 0.5 && !position.breakEvenActive) {
            // Após 50% do tempo máximo, o stop começa a subir em direção a zero
            const decayFactor = Math.max(0, 1 - ((timeRatio - 0.5) / 0.5));
            dynamicStopLossPct = dynamicStopLossPct * decayFactor;
        }

        // --- NOVO: Aplicação do Break-Even ---
        if (position.breakEvenActive) {
            dynamicStopLossPct = 0.00; // Zero a Zero absoluto
        }

        if (realPnL <= -dynamicStopLossPct) {
            shouldExit = true;
            exitReason = position.breakEvenActive ? 'BREAK_EVEN_STOP' : (timeRatio > 0.5 ? 'TIME_DECAY_STOP' : 'STOP_LOSS (ATR_DYNAMIC)');
        }
        // 3. Condição de Timeout (Max Tempo Posicionado)
        else if (timeElapsedMs >= strategy.maxPositionTimeMs) {
            shouldExit = true;
            exitReason = 'TIMEOUT';
        }
    }

    if (shouldExit) {
        (strategy as any).isProcessingTrade = true;
        (strategy as any).processingSince = Date.now();
        try {
            // Se temos uma ordem pendurada (Maker), precisamos checar se já foi preenchida, ou CANCELAR
            let limitOrderWasFilled = false;
            let finalExitPrice: any = currentExitPrice;

            if (position.limitSellOrderId) {
                try {
                    const fetchedSell = await exchange.fetchOrder(position.limitSellOrderId, strategy.symbol);
                    if (fetchedSell.status === 'closed') {
                        limitOrderWasFilled = true;
                        finalExitPrice = fetchedSell.average || fetchedSell.price || currentExitPrice;
                        logger.info(`🟢 [LIMIT EXECUTADA] Ordem Limit Sell foi totalmente preenchida a $${finalExitPrice}!`);
                    } else {
                        logger.info(`⚠️ Cancelando Ordem Limit pendente (${position.limitSellOrderId}) para saída ${exitReason}...`);
                        await exchange.cancelOrder(position.limitSellOrderId, strategy.symbol);
                    }
                } catch (e: any) {
                    // Se falhar em cancelar, pode significar que acabou de fechar. 
                    if (e.message.toLowerCase().includes('not found') || e.message.toLowerCase().includes('closed')) {
                        limitOrderWasFilled = true;
                        logger.info(`🟢 [LIMIT EXECUTADA] Ordem Limit não encontrada para cancelar (provavelmente executou agora).`);
                    } else {
                        logger.warn(`Aviso: erro ao checar/cancelar Limit Sell: ${e.message}`);
                    }
                }
            }

            // Se não executou pela Limit (ex: Stop Loss ou Timeout), vendemos a mercado (Limit Taker)
            let sellOrderId = position.limitSellOrderId;
            let soldAmount = position.amount;
            let isPartialExit = false;

            if (!limitOrderWasFilled) {
                logger.info(`🔴 [INICIANDO SAÍDA A MERCADO: ${exitReason}] HFT Scalper (${strategy.name}). PnL atual: ${realPnL.toFixed(4)}%`);
                let sellAmount = position.amount;
                if (exchange.amountToPrecision) {
                    sellAmount = Number(exchange.amountToPrecision(strategy.symbol, position.amount));
                }

                // Minimum order size guard
                if (exchange.markets?.[strategy.symbol]) {
                    const minAmount = (exchange.markets[strategy.symbol] as any)?.limits?.amount?.min || 0;
                    if (sellAmount < minAmount && minAmount > 0) {
                        logger.warn(`⚠️ [MIN SIZE] Qtd ${sellAmount} abaixo do mínimo ${minAmount}. Descartando posição residual.`);
                        await removePosition(stratId);
                        return;
                    }
                }

                const safeBufferSell = Math.max(strategy.bufferPercentage, 0.1); 
                const limitSellPrice = currentPrice * (1 - (safeBufferSell / 100));
                
                const apiStart = performance.now();
                const order = await exchange.createLimitSellOrder(strategy.symbol, sellAmount, limitSellPrice);
                const apiEnd = performance.now();
                logger.debug(`⚡ [LATÊNCIA CIRÚRGICA API] Disparo da ordem de SAÍDA para a Exchange levou ${(apiEnd - apiStart).toFixed(2)}ms`);
                
                sellOrderId = order.id;

                let fetchedOrder = order;
                finalExitPrice = order.average;
                if (!finalExitPrice && order.id && exchange.has['fetchOrder']) {
                    try {
                        await new Promise(res => setTimeout(res, 500));
                        fetchedOrder = await exchange.fetchOrder(order.id, strategy.symbol);
                        if (fetchedOrder.average) {
                            finalExitPrice = fetchedOrder.average;
                        }
                    } catch (e: any) {
                        logger.debug(`Aviso: não foi possível fazer fetchOrder da saída a mercado: ${e.message}`);
                    }
                }
                finalExitPrice = finalExitPrice || ticker.bid || currentPrice;

                // --- NOVO: ESCUDO DE VENDA PARCIAL ---
                if (fetchedOrder && fetchedOrder.filled !== undefined) {
                    if (fetchedOrder.filled > 0 && fetchedOrder.filled < position.amount) {
                        soldAmount = fetchedOrder.filled;
                        isPartialExit = true;
                        logger.warn(`⚠️ [VENDA PARCIAL] A exchange preencheu apenas ${soldAmount} de ${position.amount}. Mantendo o resto na posição!`);
                    } else if (fetchedOrder.filled === 0 && fetchedOrder.status !== 'closed') {
                        logger.error(`❌ [VENDA ZERADA] A ordem não preencheu nada no book (0 filled). Retentando.`);
                        throw new Error("Ordem preencheu 0. Mercado sem liquidez imediata no preço enviado.");
                    }
                }
            }

            const finalPnl = ((finalExitPrice - position.entryPrice) / position.entryPrice) * 100;
            const keyIdStr = strategy.keyIdStr || strategy.exchangeKeyId._id.toString();

            logger.info(`✅ [SAÍDA CONCLUÍDA] Vendeu ${soldAmount} de ${strategy.symbol} a $${finalExitPrice.toFixed(4)}. Tempo: ${timeElapsedMs}ms. PnL Final: ${finalPnl.toFixed(4)}%`);

            if (isPartialExit) {
                // Atualiza a posição na memória mas não deleta!
                position.amount -= soldAmount;
                await ScalpingTrade.findByIdAndUpdate(position.tradeId, {
                    errorMessage: `Venda Parcial: ${soldAmount} vendidos a $${finalExitPrice.toFixed(4)}. Restam ${position.amount}.`
                });
            } else {
                // 3. Atualizar Banco de Dados
                await ScalpingTrade.findByIdAndUpdate(position.tradeId, {
                    status: 'success',
                    exitPrice: finalExitPrice,
                    exitTxid: sellOrderId,
                    pnl: finalPnl,
                    errorMessage: exitReason,
                    exitTime: new Date()
                });

                // Limpar a posição
                await removePosition(stratId);

                // --- NOVO: COOLDOWN ANTI-VIOLINADA (configurável via Dashboard) ---
                if (finalPnl < 0) {
                    const lossUsd = Math.abs((finalExitPrice - position.entryPrice) * soldAmount);
                    accumulateDailyLoss(strategy.userId?.toString() || '', lossUsd);
                    const cooldownMs = strategy.postLossCooldownMs || 5 * 60 * 1000;
                    cooldowns[stratId] = Date.now() + cooldownMs;
                    logger.info(`❄️ [COOLDOWN] Estratégia ${strategy.symbol} pausada por ${(cooldownMs / 60000).toFixed(0)}min após um Loss. ($${lossUsd.toFixed(2)})`);
                } else {
                    cooldowns[stratId] = Date.now() + 30 * 1000;
                }
            }

            // 4. Atualizar o saldo real após a venda
            // Em vez de atualizar otimisticamente (o que pode causar Insufficient Position se a ordem Limit não filar tudo),
            // buscamos o saldo real na exchange, já que a operação de venda já foi pro book e não temos pressa para a PRÓXIMA entrada.
            try {
                logger.info(`[DEBUG] Atualizando saldo real após saída para liberar reentrada...`);
                const newBalance = await exchange.fetchBalance();
                await updateCachedBalance(keyIdStr, newBalance);
            } catch (err: any) {
                logger.warn(`Aviso: falha ao atualizar saldo pós-venda: ${err.message}`);
            }
            
        } catch (err: any) {
            logger.error(`❌ [FALHA NA SAÍDA] Erro ao executar venda a mercado para ${strategy.name}: ${err.message}`);
            
            await ScalpingTrade.findByIdAndUpdate(position.tradeId, {
                errorMessage: `Falha ao vender (${exitReason}): ${err.message}. Retentando em 2.5s...`
            }).catch(dbErr => logger.error('Falha ao atualizar DB no erro de saída', dbErr));

            // ESCUDO ANTI-BANIMENTO: Atrasa a liberação do lock em 2.5 segundos para não marretar a API
            await new Promise(res => setTimeout(res, 2500));
        } finally {
            (strategy as any).isProcessingTrade = false;
        }
        const tickEnd = performance.now();
        logger.debug(`⏱️ [LATÊNCIA DE SAÍDA] O processamento completo de saída levou ${(tickEnd - tickStart).toFixed(2)}ms`);
    }
    } // Fim do if (position && position.status === 'in_position')
    
    // Se não entrou nem saiu (só analisou), logamos latência se for anormal
    if (!position || position.status !== 'in_position') {
        const tickEnd = performance.now();
        const elapsed = tickEnd - tickStart;
        if (elapsed > 20) {
            logger.warn(`⚠️ [LENTIDÃO DE TICK] A análise do tick levou ${elapsed.toFixed(2)}ms. Pode indicar gargalo.`);
        }
    }
} // Fim do processTick

async function watchStrategyLoop(strategy: any) {
    if (!strategy.exchangeKeyId) return;

    const exchange = await getOrCreateExchangeInstance(strategy.exchangeKeyId);
    if (!exchange) return;

    logger.info(`Subscrevendo ao WebSocket [Ticker] de ${strategy.symbol} na ${exchange.id}...`);

    const stratId = strategy._id.toString();
    runningLoops[stratId] = true;

    // Lança os rastreadores de background em paralelo
    watchTrendLoop(strategy, exchange).catch(e => logger.error(`Erro no Trend Loop para ${strategy.symbol}: ${e.message}`));
    watchOrderBookLoop(strategy, exchange).catch(e => logger.error(`Erro no OrderBook Loop para ${strategy.symbol}: ${e.message}`));

    while (isRunning && runningLoops[stratId]) {
        try {
            // Verificar a cada iteração do loop se a estratégia foi pausada no Dashboard
            const currentStrat = activeStrategies.find(s => s._id.toString() === stratId);
            if (!currentStrat) {
                // Se a estratégia foi pausada, mas TEMOS posição aberta, NÃO podemos desligar!
                if (positions[stratId]) {
                    if (!strategy.isPaused) {
                        logger.warn(`⚠️ Estratégia ${strategy.name} pausada no Dashboard, mas existe posição aberta! Mantendo motor HFT ativo APENAS para gerenciar a saída.`);
                        strategy.isPaused = true;
                    }
                } else {
                    logger.info(`🛑 Estratégia ${strategy.name} pausada. Nenhuma posição aberta. Encerrando loop HFT de ${strategy.symbol}...`);
                    runningLoops[stratId] = false;
                    break;
                }
            } else {
                strategy.isPaused = false;
                // Atualizar os parâmetros do HFT em tempo real caso o usuário edite via Dashboard
                Object.assign(strategy, currentStrat);
            }

            // watchTicker is a blocking promise that resolves when a new socket message arrives
            const ticker = await exchange.watchTicker(strategy.symbol);
            await processTick(ticker, strategy, exchange);
        } catch (err: any) {
            logger.error(`WebSocket Error para ${strategy.name}: ${err.message}`);
            // Aguarda um pouco antes de tentar reconectar
            await new Promise(res => setTimeout(res, 5000));
        }
    }
    
    delete runningLoops[stratId];
}

async function watchTrendLoop(strategy: any, exchange: ccxt.Exchange) {
    const stratId = strategy._id.toString();
    // O loop de tendência também vive enquanto a estratégia estiver rodando
    while (isRunning && runningLoops[stratId]) {
        try {
            // Busca as últimas velas de 1 minuto
            const ohlcv = await exchange.fetchOHLCV(strategy.symbol, '1m', undefined, 30);
            if (ohlcv && ohlcv.length > 0) {
                const closes = ohlcv.map(candle => Number(candle[4])).filter(c => !isNaN(c)); // Fechamento é o índice 4
                const ema9 = calculateEMA(closes, 9);
                const ema21 = calculateEMA(closes, 21);
                const rsi = calculateRSI(closes, 14);
                const vwap = calculateVWAP(ohlcv);
                const atr = calculateATR(ohlcv, 14);
                
                const isUptrend = ema9 > ema21;
                
                // --- NOVO: PRICE ACTION (Resistência) ---
                let recentResistance = 0;
                for (let i = 0; i < ohlcv.length - 1; i++) { // -1 ignora a vela atual aberta
                    const high = Number(ohlcv[i][2]);
                    if (high > recentResistance) recentResistance = high;
                }
                const currentPrice = closes[closes.length - 1]; // Fechamento da última vela consolidada
                const distanceToResistancePct = currentPrice > 0 ? ((recentResistance - currentPrice) / currentPrice) * 100 : 0;
                
                // Atualiza a memória de tendência global
                trends[stratId] = {
                    isUptrend,
                    ema9,
                    ema21,
                    rsi,
                    vwap,
                    atr,
                    lastUpdate: Date.now(),
                    priceAction: {
                        recentResistance,
                        distanceToResistancePct
                    }
                };

                // Reutiliza o spread já capturado pelo WebSocket ticker para evitar chamada REST extra
                let spreadPct = trends[stratId]?.spreadPct || 0;
                let spreadLog = spreadPct > 0 ? `${spreadPct.toFixed(3)}% (via WebSocket)` : 'Desconhecido';

                // Atualiza o spreadPct na memória também
                trends[stratId].spreadPct = spreadPct;

                let statusMessage = '🚀 ALTA (Liberado)';
                if (!isUptrend) {
                    statusMessage = '🩸 BAIXA (Aguardando)';
                } else if (rsi >= 70) {
                    statusMessage = '🛑 SOBRECOMPRADO';
                } else if (spreadPct >= (strategy.maxSpreadPercentage !== undefined ? strategy.maxSpreadPercentage : Math.min(strategy.stopLossPercentage, strategy.takeProfitPercentage))) {
                    statusMessage = '🛑 SPREAD ALTO';
                }

                const priceActStr = trends[stratId].priceAction ? trends[stratId].priceAction.distanceToResistancePct.toFixed(3) + '%' : 'N/A';
                logger.debug(`[TREND] ${strategy.symbol}: EMA9=${ema9.toFixed(4)} | EMA21=${ema21.toFixed(4)} | RSI=${rsi.toFixed(1)} | VWAP=${vwap.toFixed(4)} | ATR=${atr.toFixed(4)} | PriceAct: ${priceActStr} | Spread: ${spreadLog} -> ${statusMessage}`);
                
                // Salvar no Banco de Dados para o Dashboard ler
                await ScalpingStrategy.findByIdAndUpdate(stratId, {
                    currentTrend: {
                        isUptrend,
                        rsi,
                        spreadPct,
                        ema9,
                        ema21,
                        vwap,
                        atr,
                        statusMessage,
                        lastUpdate: new Date(),
                        priceAction: trends[stratId].priceAction
                    }
                }).catch(() => {});
            }
        } catch (err: any) {
            logger.error(`Aviso: falha ao buscar tendência para ${strategy.symbol}: ${err.message}`);
        }
        
        // Dorme por 15 segundos antes de checar as velas novamente
        await new Promise(res => setTimeout(res, 15000));
    }
}

async function watchOrderBookLoop(strategy: any, exchange: ccxt.Exchange) {
    const stratId = strategy._id.toString();
    while (isRunning && runningLoops[stratId]) {
        try {
            let ob;
            if (exchange.has['watchOrderBook']) {
                ob = await (exchange as any).watchOrderBook(strategy.symbol, 20);
            } else {
                ob = await exchange.fetchOrderBook(strategy.symbol, 20);
                await new Promise(res => setTimeout(res, 2000)); // Dorme se for REST
            }

            if (ob && ob.bids && ob.asks) {
                const bidVol = ob.bids.slice(0, 10).reduce((sum: number, bid: any) => sum + (bid[1] || 0), 0);
                const askVol = ob.asks.slice(0, 10).reduce((sum: number, ask: any) => sum + (ask[1] || 0), 0);
                if (bidVol > 0 && askVol > 0) {
                    const imbalance = askVol / bidVol; // Se for 3.0, tem 3x mais peso de vendedores
                    if (!trends[stratId]) trends[stratId] = {} as any;
                    trends[stratId].orderBookImbalance = imbalance;
                }
            }
        } catch (e: any) {
            // Em caso de erro na assinatura, espera um pouco para não floodar logs
            await new Promise(res => setTimeout(res, 5000));
        }
    }
}

async function hydrateOpenPositions() {
    try {
        let recoveredPositions = 0;
        let recoveredBalances = 0;
        
        if (redisClient) {
            // Hydrate Positions from Redis
            const redisPositions = await redisClient.hgetall('hft:positions');
            for (const stratId in redisPositions) {
                try {
                    const pos = JSON.parse(redisPositions[stratId]);
                    positions[stratId] = pos;
                    recoveredPositions++;
                } catch (e) {}
            }
            
            // Hydrate Balances from Redis
            const redisBalances = await redisClient.hgetall('hft:balances');
            for (const keyId in redisBalances) {
                try {
                    const bal = JSON.parse(redisBalances[keyId]);
                    cachedBalances[keyId] = bal;
                    recoveredBalances++;
                } catch (e) {}
            }
            
            if (recoveredPositions > 0 || recoveredBalances > 0) {
                logger.info(`♻️ [HYDRATION] Recuperados do Redis: ${recoveredPositions} posições e ${recoveredBalances} saldos!`);
            }
        } else {
            // Fallback for MongoDB se Redis não estiver configurado
            const openTrades = await ScalpingTrade.find({ status: { $in: ['in_position', 'entry_pending'] } });
            for (const trade of openTrades) {
                if (trade.strategyId) {
                    const stratId = trade.strategyId.toString();
                    if (!positions[stratId]) {
                        positions[stratId] = {
                            tradeId: trade._id.toString(),
                            entryPrice: trade.entryPrice || trade.price || 0,
                            entryTime: trade.createdAt ? new Date(trade.createdAt).getTime() : Date.now(),
                            amount: trade.amount || 0,
                            side: trade.type as 'buy' | 'sell',
                            status: trade.status as 'in_position' | 'entry_pending',
                            limitBuyOrderId: trade.entryTxid
                        };
                        recoveredPositions++;
                    }
                }
            }
            if (recoveredPositions > 0) {
                logger.info(`♻️ [HYDRATION] ${recoveredPositions} posições abertas recuperadas do MongoDB.`);
            }
        }
    } catch (e: any) {
        logger.error(`Falha ao recuperar estado na inicialização: ${e.message}`);
    }
}

async function cleanupFailedTrades() {
    try {
        const result = await ScalpingTrade.deleteMany({ status: 'failed' });
        if (result.deletedCount && result.deletedCount > 0) {
            logger.info(`🧹 [LIMPEZA] ${result.deletedCount} registros de trades falhos (failed) foram removidos do banco de dados.`);
        }
    } catch (e: any) {
        logger.error(`Falha ao limpar trades falhos: ${e.message}`);
    }
}

async function startScalpingEngine() {
    logger.info('======================================================');
    logger.info('⚡ INICIANDO MOTOR HFT DE SCALPING (WEBSOCKETS CCXT PRO)');
    logger.info('======================================================');

    try {
        await DatabaseService.connect();
        require('../../../models/ExchangeKey');
        require('../../../models/BotStatus');

        await fetchActiveStrategies();
        await hydrateOpenPositions();
        
        isRunning = true;

        if (activeStrategies.length === 0) {
            logger.warn("Nenhuma estratégia CEX HFT ativa no momento. Aguardando...");
        }

        // Inicia um loop isolado de WebSocket para cada estratégia ativa
        activeStrategies.forEach(strat => {
            watchStrategyLoop(strat).catch(e => logger.error(`Erro fatal no loop da estratégia ${strat.name}: ${e.message}`));
        });

        // Substituição do polling de 15s por Redis Pub/Sub (Event-Driven HFT)
        const redisUrl = process.env.REDIS_URL;
        if (redisUrl) {
            const sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
            sub.on('error', (err) => {
                logger.error(`[REDIS ERROR] Conexão falhou: ${err.message}`);
            });
            sub.subscribe('hft-control');
            sub.on('message', async (channel, message) => {
                try {
                    const payload = JSON.parse(message);
                    if (payload.action === 'STRATEGY_UPDATED') {
                        const strat = await ScalpingStrategy.findById(payload.strategyId).populate('exchangeKeyId');
                        if (strat && strat.active) {
                            const idx = activeStrategies.findIndex(s => s._id.toString() === payload.strategyId);
                            if (idx >= 0) {
                                activeStrategies[idx] = strat;
                                logger.info(`[UPDATE] Estratégia atualizada via Redis: ${strat.name}`);
                            } else {
                                activeStrategies.push(strat);
                                logger.info(`[PLAY] Estratégia ativada via Redis: ${strat.name}`);
                            }
                            
                            if (!runningLoops[payload.strategyId]) {
                                watchStrategyLoop(strat).catch(e => logger.error(`Erro fatal no loop da estratégia ${strat.name}: ${e.message}`));
                            }
                        } else {
                            activeStrategies = activeStrategies.filter(s => s._id.toString() !== payload.strategyId);
                            logger.info(`[PAUSE] Estratégia pausada via Redis: ID ${payload.strategyId}`);
                        }
                    } else if (payload.action === 'STRATEGY_DELETED') {
                        activeStrategies = activeStrategies.filter(s => s._id.toString() !== payload.strategyId);
                        logger.info(`[DELETE] Estratégia removida via Redis: ID ${payload.strategyId}`);
                    }
                } catch (err: any) {
                    logger.error(`Erro no evento Redis: ${err.message}`);
                }
            });
            logger.info(`[REDIS] Ouvindo eventos em hft-control...`);
        } else {
            logger.warn('⚠️ REDIS_URL não configurada. O motor não receberá comandos em tempo real do Dashboard.');
        }

        // Mantém apenas a limpeza de trades falhos periodicamente
        setInterval(async () => {
            try {
                await cleanupFailedTrades();
            } catch (e) {
                logger.error('Erro no loop de limpeza de trades: ' + e);
            }
        }, 15000);

        setInterval(async () => {
            try {
                for (const keyId of Object.keys(exchangeInstances)) {
                    const inst = exchangeInstances[keyId];
                    await updateCachedBalance(keyId, await inst.fetchBalance());
                }
            } catch (e: any) {
                logger.error('Erro no loop de sincronização de saldo: ' + e.message);
            }
        }, 15000);

        const takeSnapshot = async () => {
            if (!cachedUserId) return;
            try {
                for (const keyId of Object.keys(exchangeInstances)) {
                    const inst = exchangeInstances[keyId];
                    const balance = cachedBalances[keyId];
                    if (!balance || !balance.total) continue;

                    let totalUsdValue = 0;
                    const assetBalances = [];

                    for (const asset of Object.keys(balance.total)) {
                        const total = balance.total[asset];
                        if (total <= 0) continue;

                        let usdValue = 0;
                        if (asset === 'USDT' || asset === 'USDC') {
                            usdValue = total;
                        } else {
                            try {
                                const ticker = await inst.fetchTicker(`${asset}/USDT`);
                                if (ticker && ticker.last) {
                                    usdValue = total * ticker.last;
                                }
                            } catch (e) {
                                // Ignore assets without USDT pair or if fetch fails
                            }
                        }

                        totalUsdValue += usdValue;
                        assetBalances.push({
                            asset,
                            free: balance.free[asset] || 0,
                            used: balance.used[asset] || 0,
                            total,
                            usdValue
                        });
                    }

                    if (totalUsdValue > 0) {
                        const PortfolioSnapshot = (await import('../../../models/PortfolioSnapshot')).default;
                        await PortfolioSnapshot.create({
                            userId: cachedUserId,
                            exchange: inst.id,
                            totalUsdValue,
                            balances: assetBalances
                        });
                        logger.info(`📸 Snapshot salvo para ${inst.id}: $${totalUsdValue.toFixed(2)}`);
                    }
                }
            } catch (e: any) {
                logger.error(`Erro ao salvar PortfolioSnapshot: ${e.message}`);
            }
        };

        // Salvar Snapshot do Portfólio a cada 15 minutos (900000 ms)
        setInterval(takeSnapshot, 15 * 60 * 1000);
        
        // Disparar uma vez após 15 segundos para popular o dashboard imediatamente após o boot (caso esteja vazio)
        setTimeout(takeSnapshot, 15000);

        // Heartbeat para o Dashboard saber que estamos vivos
        let cachedUserId: string | null = null;
        setInterval(async () => {
            if (!cachedUserId) {
                // Tenta achar qualquer estratégia (ativa ou pausada) apenas para descobrir o userId do dono do robô
                const anyStrat = await ScalpingStrategy.findOne({});
                if (anyStrat) {
                    cachedUserId = anyStrat.userId;
                }
            }

            if (cachedUserId) {
                try {
                    await BotStatus.findOneAndUpdate(
                        { userId: cachedUserId, botName: 'scalping-cex' },
                        { lastHeartbeat: new Date() },
                        { upsert: true }
                    );
                } catch (e) {
                    // ignorar erros de rede no heartbeat
                }
            }
        }, 5000);

    } catch (err) {
        logger.error('❌ Falha ao iniciar scalping bot: ' + err);
        process.exit(1);
    }
}

startScalpingEngine();
