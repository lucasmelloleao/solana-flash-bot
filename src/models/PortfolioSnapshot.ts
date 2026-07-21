import mongoose from 'mongoose';

const AssetBalanceSchema = new mongoose.Schema({
    asset: {
        type: String,
        required: true
    },
    free: {
        type: Number,
        required: true,
        default: 0
    },
    used: {
        type: Number,
        required: true,
        default: 0
    },
    total: {
        type: Number,
        required: true,
        default: 0
    },
    usdValue: {
        type: Number,
        required: true,
        default: 0
    }
}, { _id: false });

const PortfolioSnapshotSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    exchange: {
        type: String,
        required: true
    },
    totalUsdValue: {
        type: Number,
        required: true,
        default: 0
    },
    balances: [AssetBalanceSchema],
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    }
}, { timestamps: true });

PortfolioSnapshotSchema.index({ userId: 1, exchange: 1, timestamp: -1 });

export default mongoose.models.PortfolioSnapshot || mongoose.model('PortfolioSnapshot', PortfolioSnapshotSchema);
