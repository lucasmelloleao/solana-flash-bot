import { DatabaseService } from '../../services/DatabaseService';
import ScalpingStrategy from '../../../models/ScalpingStrategy';
import ScalpingTrade from '../../../models/ScalpingTrade';
import BotStatus from '../../../models/BotStatus';
import { decryptSecretKey } from '../../../utils/encryption';
import * as ccxt from 'ccxt';

const logger = {
    info: (msg: string, obj?: any) => console.log(`\n[INFO] ${msg}`, obj || ''),
    warn: (msg: string, obj?: any) => console.warn(`\n[WARN] ${msg}`, obj || ''),
    error: (msg: string, obj?: any) => console.error(`\n[ERROR] ${msg}`, obj || ''),
};

let activeStrategies: any[] = [];
let isRunning = false;
const runningLoops: Record<string, boolean> = {}; // Mapeia o ID da estratégia para saber se ela já está rodando

// Cache ccxt.pro instances by ExchangeKey ID
const exchangeInstances: Record<string, ccxt.Exchange> = {};
const cachedBalances: Record<string, any> = {};

// Stateful memory of open positions
type OpenPosition = {
    tradeId: string;
    entryPrice: number;
    entryTime: number;
    amount: number;
    side: 'buy' | 'sell';
};
const positions: Record<string, OpenPosition> = {};

type TrendData = {
    isUptrend: boolean;
    ema9: number;
    ema21: number;
    rsi: number;
    lastUpdate: number;
};
const trends: Record<string, TrendData> = {};

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

    if ((ccxt as any).pro[exchangeId]) {
        const ExchangeClass = (ccxt as any).pro[exchangeId] as any;
        const instance = new ExchangeClass({
            apiKey: apiKey,
            secret: decryptedSecret,
            enableRateLimit: true,
        });

        exchangeInstances[keyIdStr] = instance;
        logger.info(`Conexão WebSocket com a CEX ${exchangeId.toUpperCase()} iniciada com sucesso.`);

        try {
            logger.info(`Buscando saldo inicial para ${exchangeId.toUpperCase()}...`);
            const initialBalance = await instance.fetchBalance();
            cachedBalances[keyIdStr] = initialBalance;
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
        if (Date.now() - processingSince > 10000) {
            logger.warn(`[DEBUG] Resetando isProcessingTrade travado há mais de 10s para ${strategy.name}`);
            (strategy as any).isProcessingTrade = false;
        } else {
            return;
        }
    }

    // Se NÃO tem posição aberta, EXECUTAR a ENTRADA (Compra real ao mercado)
    if (!position) {
        // Se a estratégia foi pausada pelo usuário, nós apenas observamos, não compramos
        if (!strategy.active) {
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

        if (currentSpread >= strategy.stopLossPercentage || currentSpread >= strategy.takeProfitPercentage) {
            // Se o spread for maior que o stop loss OU maior que o take profit, o trade é matematicamente inviável
            return; 
        }

        if (!trend || !trend.isUptrend) {
            // Ignora o tick se o mercado não estiver validado como Tendência de Alta
            return;
        }
        if (trend.rsi >= 70) {
            // Ignora o tick se o ativo estiver esticado/sobrecomprado (risco de queda iminente)
            return;
        }

        (strategy as any).isProcessingTrade = true;
        (strategy as any).processingSince = Date.now();
        try {
            logger.info(`🟢 [INICIANDO ENTRADA] HFT Scalper (${strategy.name}) vai analisar compra a mercado (Ticker ~$${currentPrice})...`);

            logger.info(`[DEBUG] Validando saldo em memória...`);
            const quoteAsset = strategy.symbol.split('/')[1];

            // 1. Checagem de Saldo Rápida (Memória)
            const keyIdStr = strategy.exchangeKeyId._id.toString();
            const balance = cachedBalances[keyIdStr];

            if (!balance) {
                logger.warn(`Saldo não sincronizado ainda para a estratégia ${strategy.name}. Ignorando tick...`);
                (strategy as any).isProcessingTrade = false;
                return;
            }

            const quoteBalance = (balance?.free as any)?.[quoteAsset] ?? 0;
            const estimatedCost = strategy.tradeSize; // $30 USDC

            if (quoteBalance < estimatedCost * 1.05) {
                logger.warn(`Saldo insuficiente em ${quoteAsset} para a estratégia ${strategy.name}. Necessário ~$${(estimatedCost * 1.05).toFixed(4)}, Livre: $${quoteBalance}`);
                (strategy as any).isProcessingTrade = false;
                return;
            }

            // Converter o valor em dólares (USDC) para a quantidade da moeda (SOL)
            const baseAmount = strategy.tradeSize / currentPrice;

            // 2. Precisão da ordem
            let formattedAmount = baseAmount;
            if (exchange.amountToPrecision) {
                formattedAmount = Number(exchange.amountToPrecision(strategy.symbol, baseAmount));
            }

            // 3. Execução Real
            // Muitas CEX (como a MEXC) desativam ordens Market no Spot. Para garantir execução imediata (Taker), 
            // usamos Limit Orders enviando o preço um pouco pior (Slippage Buffer), o que cruza o livro imediatamente.
            const safeBufferBuy = Math.max(strategy.bufferPercentage, 0.1); // No mínimo 0.1% para garantir o fill
            const limitBuyPrice = currentPrice * (1 + (safeBufferBuy / 100));
            logger.info(`🚀 HFT ATIVADO: Enviando Limit Buy de ${formattedAmount} SOL a $${limitBuyPrice.toFixed(4)}...`);
            const order = await exchange.createLimitBuyOrder(strategy.symbol, formattedAmount, limitBuyPrice);

            // Subtrair otimisticamente do saldo em memória para evitar que o próximo tick compre novamente antes do update de 15s
            if (cachedBalances[keyIdStr]?.free?.[quoteAsset]) {
                (cachedBalances[keyIdStr].free as any)[quoteAsset] -= estimatedCost;
            }

            const entryPrice = order.average || order.price || currentPrice;
            const filledAmount = order.filled || formattedAmount;

            // 4. Salvar no DB
            const tradeDoc = await ScalpingTrade.create({
                userId: strategy.userId,
                strategyId: strategy._id,
                type: 'buy', // Indicates we started with a buy
                symbol: strategy.symbol,
                price: entryPrice, // For backward compatibility
                entryPrice: entryPrice,
                amount: filledAmount,
                status: 'in_position',
                entryTxid: order.id || order.info?.id || order.clientOrderId
            });

            positions[stratId] = {
                tradeId: tradeDoc._id.toString(),
                entryPrice: entryPrice,
                entryTime: Date.now(),
                amount: filledAmount,
                side: 'buy'
            };

            logger.info(`✅ [ENTRADA CONCLUÍDA] Comprou ${filledAmount} de ${strategy.symbol} a $${entryPrice.toFixed(4)}. ID: ${order.id}`);
        } catch (err: any) {
            logger.error(`❌ [FALHA NA ENTRADA] Erro ao executar compra a mercado para ${strategy.name}: ${err.message}`);
        } finally {
            (strategy as any).isProcessingTrade = false;
        }
        return;
    }

    // Se TEM posição aberta, verificar as condições de SAÍDA (Gestão de Risco HFT)
    const timeElapsedMs = Date.now() - position.entryTime;
    const priceDiffPercentage = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

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

    // 1. Condição de Lucro Dinâmico (Micro-Scalping vencendo o Spread + 1% de lucro livre)
    if (currentSpread > 0 && priceDiffPercentage >= (currentSpread * 1.01)) {
        shouldExit = true;
        exitReason = 'SPREAD_PROFIT';
    }
    // 2. Condição de Take Profit Fixo
    else if (priceDiffPercentage >= strategy.takeProfitPercentage) {
        shouldExit = true;
        exitReason = 'TAKE_PROFIT';
    }
    // 2. Condição de Stop Loss
    else if (priceDiffPercentage <= -strategy.stopLossPercentage) {
        shouldExit = true;
        exitReason = 'STOP_LOSS';
    }
    // 3. Condição de Timeout (Max Tempo Posicionado)
    else if (timeElapsedMs >= strategy.maxPositionTimeMs) {
        shouldExit = true;
        exitReason = 'TIMEOUT';
    }

    if (shouldExit) {
        (strategy as any).isProcessingTrade = true;
        (strategy as any).processingSince = Date.now();
        try {
            logger.info(`🔴 [INICIANDO SAÍDA: ${exitReason}] HFT Scalper (${strategy.name}) vai vender a mercado. PnL atual: ${priceDiffPercentage.toFixed(4)}%`);

            // 1. Precisão
            let sellAmount = position.amount;
            if (exchange.amountToPrecision) {
                sellAmount = Number(exchange.amountToPrecision(strategy.symbol, position.amount));
            }

            // 2. Execução Real (Saída Limit Taker)
            const safeBufferSell = Math.max(strategy.bufferPercentage, 0.1); // No mínimo 0.1%
            const limitSellPrice = currentPrice * (1 - (safeBufferSell / 100));
            const order = await exchange.createLimitSellOrder(strategy.symbol, sellAmount, limitSellPrice);
            const exitPrice = order.average || order.price || currentPrice;
            const finalPnl = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;

            const keyIdStr = strategy.keyIdStr || strategy.exchangeKeyId._id.toString();

            logger.info(`✅ [SAÍDA CONCLUÍDA] Vendeu ${sellAmount} de ${strategy.symbol} a $${exitPrice.toFixed(4)}. Tempo: ${timeElapsedMs}ms. PnL Final: ${finalPnl.toFixed(4)}%`);

            // 3. Atualizar Banco de Dados
            await ScalpingTrade.findByIdAndUpdate(position.tradeId, {
                status: 'success',
                exitPrice: exitPrice,
                exitTxid: order.id || order.info?.id || order.clientOrderId,
                pnl: finalPnl,
                errorMessage: exitReason
            });

            // Limpar a posição
            delete positions[stratId];

            // 4. Atualizar o saldo real após a venda
            // Em vez de atualizar otimisticamente (o que pode causar Insufficient Position se a ordem Limit não filar tudo),
            // buscamos o saldo real na exchange, já que a operação de venda já foi pro book e não temos pressa para a PRÓXIMA entrada.
            try {
                logger.info(`[DEBUG] Atualizando saldo real após saída para liberar reentrada...`);
                const newBalance = await exchange.fetchBalance();
                cachedBalances[keyIdStr] = newBalance;
            } catch (e: any) {
                logger.warn(`Aviso: falha ao atualizar saldo pós-venda: ${e.message}`);
            }
            
        } catch (err: any) {
            logger.error(`❌ [FALHA NA SAÍDA] Erro ao executar venda a mercado para ${strategy.name}: ${err.message}`);

            // Atualizar status para failed se der erro critico (opcional tentar novamente depois)
            await ScalpingTrade.findByIdAndUpdate(position.tradeId, {
                status: 'failed',
                errorMessage: `Erro na saída (${exitReason}): ${err.message}`
            }).catch(dbErr => logger.error('Falha ao atualizar DB no erro de saída', dbErr));

            // Removemos a posição da memória ou mantemos para tentar sair no próximo tick?
            // HFT geralmente deve limpar e assumir intervenção manual ou retentativa agressiva.
            // Para não travar, vamos apagar da memória. O trade fica failed no DB.
            delete positions[stratId];
        } finally {
            (strategy as any).isProcessingTrade = false;
        }
    }
}

async function watchStrategyLoop(strategy: any) {
    if (!strategy.exchangeKeyId) return;

    const exchange = await getOrCreateExchangeInstance(strategy.exchangeKeyId);
    if (!exchange) return;

    logger.info(`Subscrevendo ao WebSocket [Ticker] de ${strategy.symbol} na ${exchange.id}...`);

    const stratId = strategy._id.toString();
    runningLoops[stratId] = true;

    // Lança o Rastreador de Tendências em paralelo, garantindo que a exchange existe
    watchTrendLoop(strategy, exchange).catch(e => logger.error(`Erro no Trend Loop para ${strategy.symbol}: ${e.message}`));

    while (isRunning && runningLoops[stratId]) {
        try {
            // Verificar a cada iteração do loop se a estratégia foi pausada no Dashboard
            const currentStrat = activeStrategies.find(s => s._id.toString() === stratId);
            if (!currentStrat) {
                logger.info(`Estratégia ${strategy.name} foi pausada ou removida. Encerrando loop HFT de ${strategy.symbol}...`);
                runningLoops[stratId] = false;
                break;
            }

            // Atualizar os parâmetros do HFT em tempo real caso o usuário edite via Dashboard
            Object.assign(strategy, currentStrat);

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
                const closes = ohlcv.map(candle => candle[4]); // Fechamento é o índice 4
                
                const ema9 = calculateEMA(closes, 9);
                const ema21 = calculateEMA(closes, 21);
                const rsi = calculateRSI(closes, 14);
                
                const isUptrend = ema9 > ema21;
                
                // Atualiza a memória de tendência global
                trends[stratId] = {
                    isUptrend,
                    ema9,
                    ema21,
                    rsi,
                    lastUpdate: Date.now()
                };

                let spreadLog = 'Desconhecido';
                let spreadPct = 0;
                try {
                    const t = await exchange.fetchTicker(strategy.symbol);
                    if (t.bid && t.ask) {
                        spreadPct = ((t.ask - t.bid) / t.bid) * 100;
                        spreadLog = `${spreadPct.toFixed(3)}% (Bid:$${t.bid} Ask:$${t.ask})`;
                    }
                } catch(e) {}

                let statusMessage = '🚀 ALTA (Liberado)';
                if (!isUptrend) {
                    statusMessage = '🩸 BAIXA (Aguardando)';
                } else if (rsi >= 70) {
                    statusMessage = '🛑 SOBRECOMPRADO';
                } else if (spreadPct >= strategy.stopLossPercentage || spreadPct >= strategy.takeProfitPercentage) {
                    statusMessage = '🛑 SPREAD ALTO';
                }

                logger.info(`[TREND] ${strategy.symbol}: EMA9=${ema9.toFixed(4)} | EMA21=${ema21.toFixed(4)} | RSI=${rsi.toFixed(1)} | Spread: ${spreadLog} -> ${statusMessage}`);
                
                // Salvar no Banco de Dados para o Dashboard ler
                await ScalpingStrategy.findByIdAndUpdate(stratId, {
                    currentTrend: {
                        isUptrend,
                        rsi,
                        spreadPct,
                        ema9,
                        ema21,
                        statusMessage,
                        lastUpdate: new Date()
                    }
                }).catch(() => {});
            }
        } catch (err: any) {
            logger.error(`Aviso: falha ao buscar tendência para ${strategy.symbol}: ${err.message}`);
        }
        
        // Dorme por 30 segundos antes de checar as velas novamente
        await new Promise(res => setTimeout(res, 30000));
    }
}

async function startScalpingEngine() {
    console.log('\n======================================================');
    console.log('⚡ INICIANDO MOTOR HFT DE SCALPING (WEBSOCKETS CCXT PRO)');
    console.log('======================================================\n');

    try {
        await DatabaseService.connect();
        require('../../../models/ExchangeKey');
        require('../../../models/BotStatus');

        await fetchActiveStrategies();
        isRunning = true;

        if (activeStrategies.length === 0) {
            logger.warn("Nenhuma estratégia CEX HFT ativa no momento. Aguardando...");
        }

        // Inicia um loop isolado de WebSocket para cada estratégia ativa
        activeStrategies.forEach(strat => {
            watchStrategyLoop(strat).catch(e => logger.error(`Erro fatal no loop da estratégia ${strat.name}: ${e.message}`));
        });

        // Loop paralelo para atualizar as definições de estratégias vindas do banco a cada 15s
        setInterval(async () => {
            try {
                await fetchActiveStrategies();
                
                // Checar se há novas estratégias para iniciar (que deram Play)
                activeStrategies.forEach(strat => {
                    const idStr = strat._id.toString();
                    if (!runningLoops[idStr]) {
                        logger.info(`[PLAY] Iniciando loop HFT para a estratégia recém-ativada: ${strat.name}`);
                        watchStrategyLoop(strat).catch(e => logger.error(`Erro fatal no loop da estratégia ${strat.name}: ${e.message}`));
                    }
                });

                if (activeStrategies.length === 0) {
                    console.log('\n[WARN] Nenhuma estratégia CEX HFT ativa no momento. Aguardando...');
                } else {
                    console.log(`\n[INFO] Sincronização: ${activeStrategies.length} estratégias rodando no motor HFT.`);
                }
            } catch (e) {
                console.error("Erro ao atualizar estratégias:", e);
            }
        }, 15000);

        setInterval(async () => {
            try {
                for (const keyId of Object.keys(exchangeInstances)) {
                    const inst = exchangeInstances[keyId];
                    cachedBalances[keyId] = await inst.fetchBalance();
                }
            } catch (e: any) {
                console.error("Erro no loop de sincronização de saldo:", e.message);
            }
        }, 15000);

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
        console.error('❌ Falha ao iniciar scalping bot:', err);
        process.exit(1);
    }
}

startScalpingEngine();
