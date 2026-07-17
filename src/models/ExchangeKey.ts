import mongoose from 'mongoose';

const ExchangeKeySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  exchangeId: { type: String, required: true },
  name: { type: String, required: true },
  apiKey: { type: String, required: true },
  apiSecret: { type: String, required: true },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.ExchangeKey || mongoose.model('ExchangeKey', ExchangeKeySchema);
