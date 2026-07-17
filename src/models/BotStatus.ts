import mongoose from 'mongoose';

const BotStatusSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  botName: { type: String, required: true }, // e.g. 'scalping-cex', 'flashloan'
  lastHeartbeat: { type: Date, required: true }
});

BotStatusSchema.index({ userId: 1, botName: 1 }, { unique: true });

export default mongoose.models.BotStatus || mongoose.model('BotStatus', BotStatusSchema);
