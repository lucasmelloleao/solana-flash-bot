import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

const redisUrl = process.env.REDIS_URL;
let redisClient: Redis | null = null;

if (redisUrl) {
    redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        retryStrategy(times) {
            const delay = Math.min(times * 50, 2000);
            return delay;
        }
    });

    redisClient.on('connect', () => {
        logger.info('🟢 [RedisService] Conectado ao Redis');
    });

    redisClient.on('error', (err) => {
        logger.error(`🔴 [RedisService] Erro no Redis: ${err.message}`);
    });
} else {
    logger.warn('⚠️ [RedisService] REDIS_URL não configurado. Cache e Locks distribuídos estão desativados.');
}

export default redisClient;
