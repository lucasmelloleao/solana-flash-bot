import mongoose from 'mongoose';

const ScalpingStrategySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  exchangeKeyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExchangeKey', required: true },
  name: { type: String, required: true },
  symbol: { type: String, required: true }, // e.g. 'SOL/USDT'
  tradeSize: { type: Number, required: true }, // Size in base currency or quote currency
  takeProfitPercentage: { type: Number, required: true },
  stopLossPercentage: { type: Number, required: true },
  maxSpreadPercentage: { type: Number, default: 0.1 },
  maxPositionTimeMs: { type: Number, default: 30000 },
  bufferPercentage: { type: Number, default: 0.01 },
  active: { type: Boolean, default: true },
  currentTrend: {
    isUptrend: Boolean,
    rsi: Number,
    spreadPct: Number,
    ema9: Number,
    ema21: Number,
    vwap: Number,
    atr: Number,
    statusMessage: String,
    lastUpdate: Date,
    priceAction: {
      recentResistance: Number,
      distanceToResistancePct: Number
    }
  }
}, {
  timestamps: {
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  }
});

export default mongoose.models.ScalpingStrategy || mongoose.model('ScalpingStrategy', ScalpingStrategySchema);
