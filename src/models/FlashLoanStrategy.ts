import mongoose from 'mongoose';

const FlashLoanStrategySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true },
  name: { type: String, required: true },
  tokenAMint: { type: String, required: true, default: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, // USDC
  tokenBMint: { type: String, required: true },
  tokenBSymbol: { type: String, required: true, default: 'UNKNOWN' },
  borrowAmount: { type: Number, required: true }, // raw amount
  minProfitUsdc: { type: Number, default: 0 },
  provider: { type: String, enum: ['jupiter', 'raptor'], default: 'jupiter' },
  lendingProvider: { type: String, enum: ['solend', 'kamino'], default: 'solend' },
  active: { type: Boolean, default: true },
  temporary: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.FlashLoanStrategy || mongoose.model('FlashLoanStrategy', FlashLoanStrategySchema);
