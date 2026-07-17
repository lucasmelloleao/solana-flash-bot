import mongoose from 'mongoose';

const WalletSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  acronym: { type: String, required: true }, // e.g., 'SOLANA_WALLET'
  publicKey: { type: String, required: true },
  secretKey: { type: String, required: true }, // will be encrypted
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.Wallet || mongoose.model('Wallet', WalletSchema);
