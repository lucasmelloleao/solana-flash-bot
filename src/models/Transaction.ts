import mongoose from 'mongoose';

const TransactionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true },
  fromPublicKey: { type: String, required: true },
  toPublicKey: { type: String, required: true },
  amount: { type: Number, required: true },
  asset: { type: String, required: true, default: 'SOL' },
  txid: { type: String, required: true },
  status: { type: String, enum: ['success', 'failed', 'pending'], default: 'success' },
  networkFee: { type: Number, required: true }
}, { timestamps: true });

export default mongoose.models.Transaction || mongoose.model('Transaction', TransactionSchema);
