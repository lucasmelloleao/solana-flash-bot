import { PublicKey, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js';
import BN from 'bn.js';
// @ts-ignore
import BufferLayout from 'buffer-layout';
import { SolendPoolConfig } from '../../config/solend-pools';

// Constantes do Token SPL
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SOLEND_PROGRAM_ID = new PublicKey('So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo');

// Layout Helper para u64
const uint64 = (property: string = "uint64") => {
    return BufferLayout.blob(8, property);
};

export function createFlashLoanBorrowInstruction(liquidityAmount: number, userAta: PublicKey, poolConfig: SolendPoolConfig) {
    const dataLayout = BufferLayout.struct([
        BufferLayout.u8("instruction"),
        uint64("liquidityAmount"),
    ]);

    const data = Buffer.alloc(dataLayout.span);
    const amountBN = new BN(liquidityAmount);
    
    dataLayout.encode({
        instruction: 19, // FlashBorrowReserveLiquidity
        liquidityAmount: amountBN.toArrayLike(Buffer, 'le', 8),
    }, data);

    const keys = [
        { pubkey: poolConfig.liquiditySupply, isSigner: false, isWritable: true },
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: poolConfig.reserve, isSigner: false, isWritable: true },
        { pubkey: poolConfig.lendingMarket, isSigner: false, isWritable: false },
        { pubkey: poolConfig.lendingMarketAuthority, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({
        keys,
        programId: SOLEND_PROGRAM_ID,
        data,
    });
}

export function createFlashLoanRepayInstruction(liquidityAmount: number, borrowInstructionIndex: number, userAta: PublicKey, userTransferAuthority: PublicKey, poolConfig: SolendPoolConfig) {
    const dataLayout = BufferLayout.struct([
        BufferLayout.u8("instruction"),
        uint64("liquidityAmount"),
        BufferLayout.u8("borrowInstructionIndex"),
    ]);

    const data = Buffer.alloc(dataLayout.span);
    const amountBN = new BN(liquidityAmount);

    dataLayout.encode({
        instruction: 20, // FlashRepayReserveLiquidity
        liquidityAmount: amountBN.toArrayLike(Buffer, 'le', 8),
        borrowInstructionIndex: borrowInstructionIndex,
    }, data);

    const keys = [
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: poolConfig.liquiditySupply, isSigner: false, isWritable: true },
        { pubkey: poolConfig.feeReceiver, isSigner: false, isWritable: true },
        { pubkey: poolConfig.feeReceiver, isSigner: false, isWritable: true }, // hostFeeReceiver é o mesmo no main pool
        { pubkey: poolConfig.reserve, isSigner: false, isWritable: true },
        { pubkey: poolConfig.lendingMarket, isSigner: false, isWritable: false },
        { pubkey: userTransferAuthority, isSigner: true, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({
        keys,
        programId: SOLEND_PROGRAM_ID,
        data,
    });
}
