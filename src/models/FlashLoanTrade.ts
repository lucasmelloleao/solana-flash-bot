import mongoose from 'mongoose';

const FlashLoanTradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenBorrowed: { type: String, required: true },
  amountBorrowed: { type: Number, required: true },
  expectedProfit: { type: Number, required: true },
  actualProfit: { type: Number, default: 0 },
  flashLoanFee: { type: Number, required: true },
  gasFee: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'simulated', 'success', 'failed', 'reverted'], default: 'pending' },
  txid: { type: String },
  jitoBundleId: { type: String },
  errorMessage: { type: String },
  routeInfo: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
});

export default mongoose.models.FlashLoanTrade || mongoose.model('FlashLoanTrade', FlashLoanTradeSchema);
