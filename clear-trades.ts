import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
import ScalpingTrade from './src/models/ScalpingTrade';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI as string);
  const res = await ScalpingTrade.deleteMany({});
  console.log('Deleted Trades:', res.deletedCount);
  const PortfolioSnapshot = (await import('./src/models/PortfolioSnapshot')).default;
  const p = await PortfolioSnapshot.deleteMany({});
  console.log('Deleted Snapshots:', p.deletedCount);
  process.exit(0);
}
run().catch(console.error);