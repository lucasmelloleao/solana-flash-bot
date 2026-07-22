import {
    Keypair,
    PublicKey,
    TransactionInstruction,
    ComputeBudgetProgram,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
    AddressLookupTableAccount
} from '@solana/web3.js';
import bs58 from 'bs58';
import { createFlashLoanBorrowInstruction, createFlashLoanRepayInstruction } from '../strategies/flashloan/solend-helper';
import { createKaminoFlashLoanBorrowInstruction, createKaminoFlashLoanRepayInstruction } from '../strategies/flashloan/kamino-helper';
import { SolanaService } from './SolanaService';

const JITO_TIP_ACCOUNTS = [
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh'
];

function deserializeInstruction(instruction: any) {
    if (!instruction) return null;
    return new TransactionInstruction({
        programId: new PublicKey(instruction.programId),
        keys: instruction.accounts.map((key: any) => ({
            pubkey: new PublicKey(key.pubkey),
            isSigner: key.isSigner,
            isWritable: key.isWritable,
        })),
        data: Buffer.from(instruction.data, 'base64'),
    });
}

export class TransactionBuilder {
    static async buildAndSendArbitrage(
        walletKeypair: Keypair,
        borrowAmount: number,
        flashLoanFee: number,
        jitoTipLamports: number,
        instructionsARes: any,
        instructionsBRes: any,
        cachedUserAta: PublicKey | null,
        poolConfig: any,
        lendingProvider: 'solend' | 'kamino' | 'none' = 'none'
    ): Promise<{ txid: string, jitoBundleId: string | null, jitoError?: any, fullJitoResponse?: any } | null> {

        const swapA = {
            setupInstructions: (instructionsARes.setupInstructions || []).map(deserializeInstruction),
            swapInstruction: deserializeInstruction(instructionsARes.swapInstruction),
            cleanupInstruction: deserializeInstruction(instructionsARes.cleanupInstruction),
            addressLookupTableAddresses: instructionsARes.addressLookupTableAddresses || []
        };

        const swapB = {
            setupInstructions: (instructionsBRes.setupInstructions || []).map(deserializeInstruction),
            swapInstruction: deserializeInstruction(instructionsBRes.swapInstruction),
            cleanupInstruction: deserializeInstruction(instructionsBRes.cleanupInstruction),
            addressLookupTableAddresses: instructionsBRes.addressLookupTableAddresses || []
        };

        const lutAddresses = [...new Set([...swapA.addressLookupTableAddresses, ...swapB.addressLookupTableAddresses])];
        const lookupTableAccounts = await SolanaService.resolveLookupTables(lutAddresses as string[]);

        const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 });
        const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 40000 });
        const randomTipAccount = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
        const jitoTipIx = SystemProgram.transfer({ fromPubkey: walletKeypair.publicKey, toPubkey: randomTipAccount, lamports: jitoTipLamports });

        let allIxs: any[] = [];

        if (lendingProvider === 'none') {
            allIxs = [
                modifyComputeUnits,
                ...swapA.setupInstructions, swapA.swapInstruction, swapA.cleanupInstruction,
                ...swapB.setupInstructions, swapB.swapInstruction, swapB.cleanupInstruction,
                jitoTipIx
            ].filter(Boolean);
        } else {
            let borrowIx: TransactionInstruction;
            if (lendingProvider === 'kamino') {
                borrowIx = createKaminoFlashLoanBorrowInstruction(borrowAmount, cachedUserAta!, poolConfig);
            } else {
                borrowIx = createFlashLoanBorrowInstruction(borrowAmount, cachedUserAta!, poolConfig);
            }

            const preRepayIxs = [
                modifyComputeUnits, borrowIx,
                ...swapA.setupInstructions, swapA.swapInstruction, swapA.cleanupInstruction,
                ...swapB.setupInstructions, swapB.swapInstruction, swapB.cleanupInstruction,
            ].filter(Boolean);

            const borrowIxIndex = preRepayIxs.indexOf(borrowIx);
            const repayAmount = borrowAmount + flashLoanFee;

            let repayIx: TransactionInstruction;
            if (lendingProvider === 'kamino') {
                repayIx = createKaminoFlashLoanRepayInstruction(repayAmount, borrowIxIndex, cachedUserAta!, walletKeypair.publicKey, poolConfig);
            } else {
                repayIx = createFlashLoanRepayInstruction(repayAmount, borrowIxIndex, cachedUserAta!, walletKeypair.publicKey, poolConfig);
            }

            allIxs = [...preRepayIxs, repayIx, jitoTipIx];
        }

        const connection = await SolanaService.getWriteConnection();
        const { blockhash } = await connection.getLatestBlockhash('confirmed');

        let serialized;
        let transaction: VersionedTransaction;
        try {
            const messageV0 = new TransactionMessage({
                payerKey: walletKeypair.publicKey,
                recentBlockhash: blockhash,
                instructions: allIxs as TransactionInstruction[]
            }).compileToV0Message(lookupTableAccounts);
            
            transaction = new VersionedTransaction(messageV0);
            transaction.sign([walletKeypair]);
            
            serialized = transaction.serialize();
            const txBytes = serialized.byteLength;
            if (txBytes > 1232) {
                throw new Error(`TRANSACTION_TOO_LARGE:${txBytes}`);
            }
        } catch (serializeError: any) {
            
            if (serializeError.message && (serializeError.message.includes('encoding overruns Uint8Array') || serializeError.message.includes('too many account keys') || serializeError.message.includes('Account index overflow'))) {
                console.log(`\n🚨 FATAL: TRANSAÇÃO GIGANTE (> 1232 bytes)`);
                console.log(`- Total de Instruções Tentadas: ${allIxs.length}`);
                console.log(`- ALTs carregadas (Tabelas de Compressão): ${lookupTableAccounts.length}`);
                
                console.log(`-- INÍCIO DO RAIO-X DAS INSTRUÇÕES --`);
                allIxs.forEach((ix, i) => {
                    const progId = (ix as any).programId ? (ix as any).programId.toBase58() : 'Desconhecido';
                    const keys = (ix as any).keys ? (ix as any).keys.length : 0;
                    const dataLen = (ix as any).data ? (ix as any).data.length : 0;
                    console.log(`  [IX ${i}] Program: ${progId.padEnd(44)} | Contas (keys): ${keys} | Dados: ${dataLen} bytes`);
                });
                console.log(`-- FIM DO RAIO-X --\n`);
            }
            throw serializeError;
        }

        const transactionBase58 = bs58.encode(serialized);
        const txid = bs58.encode(transaction.signatures[0]);


        const jitoResponse = await SolanaService.sendJitoBundle(transactionBase58);
        
        // Simulação assíncrona para o usuário ver O MOTIVO da transação ser dropada
        SolanaService.getWriteConnection().then(async (conn) => {
            try {
                const simRes = await conn.simulateTransaction(transaction);
                if (simRes.value.err) {
                    console.log(`\n[DEBUG] 🔍 MOTIVO DO DROP (Simulação Falhou):`);
                    console.log(JSON.stringify(simRes.value.err));
                    if (simRes.value.logs) {
                        const importantLogs = simRes.value.logs.filter(l => l.toLowerCase().includes('error') || l.toLowerCase().includes('fail') || l.toLowerCase().includes('insufficient') || l.toLowerCase().includes('slippage') || l.toLowerCase().includes('exceeded'));
                        console.log(`Logs Relevantes:`, importantLogs.length > 0 ? importantLogs : simRes.value.logs.slice(-5));
                    }
                    console.log(`\n`);
                } else {
                    console.log(`\n[DEBUG] 🔍 Simulação local passou com sucesso! Se não apareceu no Solscan, você perdeu o leilão do Jito para outro robô.\n`);
                }
            } catch (e) {}
        });

        return {
            txid,
            jitoBundleId: (jitoResponse && jitoResponse.result) ? jitoResponse.result : null,
            jitoError: (jitoResponse && jitoResponse.error) ? jitoResponse.error : null,
            fullJitoResponse: jitoResponse
        };
    }
}
