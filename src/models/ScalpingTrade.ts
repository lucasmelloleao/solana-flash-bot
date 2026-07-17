import mongoose from 'mongoose';

const ScalpingTradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  strategyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ScalpingStrategy', required: true, index: true },
  type: { type: String, enum: ['buy', 'sell'], required: true },
  symbol: { type: String, required: true },
  price: { type: Number, required: true }, // Deprecated field, maintain for backward compatibility
  entryPrice: { type: Number },
  exitPrice: { type: Number },
  amount: { type: Number, required: true },
  pnl: { type: Number, default: 0 },
  status: { type: String, enum: ['entry_pending', 'in_position', 'exit_pending', 'success', 'failed', 'simulated', 'pending'], default: 'pending' },
  txid: { type: String }, // Deprecated field
  entryTxid: { type: String },
  exitTxid: { type: String },
  errorMessage: { type: String }
}, {
  timestamps: {
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  }
});

export default mongoose.models.ScalpingTrade || mongoose.model('ScalpingTrade', ScalpingTradeSchema);
