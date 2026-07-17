import { PublicKey, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js';
import BN from 'bn.js';
import { flashBorrowReserveLiquidity, flashRepayReserveLiquidity } from '@kamino-finance/klend-sdk';
import { KaminoPoolConfig } from './config/kamino-pools';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const KAMINO_PROGRAM_ID = new PublicKey('KLend2g3cPENfacJ9vnAtxXFQr1djYSU33M2hQ7D2A8');

export function createKaminoFlashLoanBorrowInstruction(liquidityAmount: number, userAta: PublicKey, poolConfig: KaminoPoolConfig): TransactionInstruction {
    const amountBN = new BN(liquidityAmount);
    
    // We pass any to bypass strict @solana/kit types, since we will map it back to web3.js
    const kitIx: any = flashBorrowReserveLiquidity(
        { liquidityAmount: amountBN },
        {
            userTransferAuthority: { address: userAta.toBase58() } as any, // Mock TransactionSigner
            lendingMarketAuthority: poolConfig.lendingMarketAuthority.toBase58() as any,
            lendingMarket: poolConfig.lendingMarket.toBase58() as any,
            reserve: poolConfig.reserve.toBase58() as any,
            reserveLiquidityMint: poolConfig.mint.toBase58() as any, 
            reserveSourceLiquidity: poolConfig.liquiditySupply.toBase58() as any,
            userDestinationLiquidity: userAta.toBase58() as any, 
            reserveLiquidityFeeReceiver: poolConfig.feeReceiver.toBase58() as any,
            referrerTokenState: { __option: 'None' } as any, 
            referrerAccount: { __option: 'None' } as any,    
            sysvarInfo: SYSVAR_INSTRUCTIONS_PUBKEY.toBase58() as any, 
            tokenProgram: TOKEN_PROGRAM_ID.toBase58() as any,
        }
    );

    return new TransactionInstruction({
        programId: new PublicKey(kitIx.programAddress),
        keys: kitIx.accounts.map((acc: any) => ({
            pubkey: new PublicKey(acc.address),
            isSigner: acc.role === 2 || acc.role === 3, // Role 2 or 3 usually means signer in @solana/kit
            isWritable: acc.role === 1 || acc.role === 3, // Role 1 or 3 means writable
        })),
        data: Buffer.from(kitIx.data),
    });
}

export function createKaminoFlashLoanRepayInstruction(
    liquidityAmount: number, 
    borrowInstructionIndex: number, 
    userAta: PublicKey, 
    userTransferAuthority: PublicKey, 
    poolConfig: KaminoPoolConfig
): TransactionInstruction {
    const amountBN = new BN(liquidityAmount);

    const kitIx: any = flashRepayReserveLiquidity(
        { 
            liquidityAmount: amountBN, 
            borrowInstructionIndex: borrowInstructionIndex 
        },
        {
            userTransferAuthority: { address: userTransferAuthority.toBase58() } as any,
            lendingMarketAuthority: poolConfig.lendingMarketAuthority.toBase58() as any,
            lendingMarket: poolConfig.lendingMarket.toBase58() as any,
            reserve: poolConfig.reserve.toBase58() as any,
            reserveLiquidityMint: poolConfig.mint.toBase58() as any, 
            reserveDestinationLiquidity: poolConfig.liquiditySupply.toBase58() as any, 
            userSourceLiquidity: userAta.toBase58() as any, 
            reserveLiquidityFeeReceiver: poolConfig.feeReceiver.toBase58() as any,
            referrerTokenState: { __option: 'None' } as any, 
            referrerAccount: { __option: 'None' } as any, 
            sysvarInfo: SYSVAR_INSTRUCTIONS_PUBKEY.toBase58() as any, 
            tokenProgram: TOKEN_PROGRAM_ID.toBase58() as any,
        }
    );

    return new TransactionInstruction({
        programId: new PublicKey(kitIx.programAddress),
        keys: kitIx.accounts.map((acc: any) => ({
            pubkey: new PublicKey(acc.address),
            isSigner: acc.role === 2 || acc.role === 3,
            isWritable: acc.role === 1 || acc.role === 3,
        })),
        data: Buffer.from(kitIx.data),
    });
}
