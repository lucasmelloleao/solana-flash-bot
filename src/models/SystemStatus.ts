import mongoose from 'mongoose';

const SystemStatusSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, default: 'global' },
  botLastHeartbeat: { type: Date, default: null },
  botMode: { type: String, enum: ['simulated', 'live'], default: 'simulated' },
  connectionMode: { type: String, enum: ['rpc', 'wss'], default: 'rpc' }
});

export default mongoose.models.SystemStatus || mongoose.model('SystemStatus', SystemStatusSchema);
