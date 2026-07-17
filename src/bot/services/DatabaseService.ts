import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import FlashLoanStrategy from '../../models/FlashLoanStrategy';
import SystemStatus from '../../models/SystemStatus';
import Wallet from '../../models/Wallet';
import { decryptSecretKey } from '../../lib/encryption';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

export class DatabaseService {
    static async connect() {
        if (!MONGODB_URI) {
            console.error('ERRO: MONGODB_URI não configurado no .env');
            process.exit(1);
        }
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Conectado ao MongoDB.');
    }

    static async getActiveStrategies() {
        try {
            return await FlashLoanStrategy.find({ active: true });
        } catch (error) {
            console.error('Erro ao carregar estratégias:', error);
            return [];
        }
    }

    static async getWalletForUser(userId: string): Promise<Keypair | null> {
        try {
            const walletDoc = await Wallet.findOne({ userId });
            if (walletDoc && walletDoc.secretKey) {
                const rawKey = decryptSecretKey(walletDoc.secretKey, walletDoc.publicKey);
                return Keypair.fromSecretKey(bs58.decode(rawKey));
            }
        } catch (error) {
            console.error(`Erro ao carregar carteira para o usuário ${userId}:`, error);
        }
        return null;
    }

    static async getWalletById(walletId: string): Promise<Keypair | null> {
        try {
            const walletDoc = await Wallet.findById(walletId);
            if (walletDoc && walletDoc.secretKey) {
                const rawKey = decryptSecretKey(walletDoc.secretKey, walletDoc.publicKey);
                return Keypair.fromSecretKey(bs58.decode(rawKey));
            }
        } catch (error) {
            console.error(`Erro ao carregar carteira ${walletId}:`, error);
        }
        return null;
    }

    static async updateHeartbeatAndGetStatus(): Promise<{ botMode: string, connectionMode: string }> {
        try {
            const status = await SystemStatus.findOneAndUpdate(
                { id: 'global' },
                { botLastHeartbeat: new Date() },
                { upsert: true, returnDocument: 'after' }
            );
            return { 
                botMode: status?.botMode || 'simulated',
                connectionMode: status?.connectionMode || 'rpc'
            };
        } catch (error) {
            return { botMode: 'simulated', connectionMode: 'rpc' };
        }
    }
}
