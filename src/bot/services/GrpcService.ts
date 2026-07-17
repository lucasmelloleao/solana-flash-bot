import Client, { CommitmentLevel } from '@triton-one/yellowstone-grpc';

export class GrpcService {
    private static client: Client | null = null;
    private static isConnected = false;

    static async getClient(): Promise<Client> {
        if (!this.client) {
            const endpoint = process.env.SOLANA_GRPC_URL;
            const token = process.env.SOLANA_GRPC_TOKEN;

            if (!endpoint || !token) {
                throw new Error('SOLANA_GRPC_URL e SOLANA_GRPC_TOKEN precisam estar no arquivo .env');
            }

            // Client constructor: endpoint, x-token, and options
            this.client = new Client(endpoint, token, undefined);
        }
        return this.client;
    }

    static async subscribeToSlots(onSlotCallback: (slot: string) => void) {
        try {
            const client = await this.getClient();
            const stream = await client.subscribe();

            stream.on('data', (data) => {
                if (data.slot) {
                    onSlotCallback(data.slot.slot.toString());
                }
            });

            stream.on('error', (err) => {
                console.error('\n❌ Erro no stream gRPC:', err.message);
                this.reconnect(onSlotCallback);
            });

            stream.on('end', () => {
                console.warn('\n⚠️ Stream gRPC encerrado. Tentando reconectar...');
                this.reconnect(onSlotCallback);
            });

            // Requisição inicial para escutar todos os slots confirmados
            await new Promise<void>((resolve, reject) => {
                stream.write({
                    slots: {
                        'blocks': {
                            filterByCommitment: true
                        }
                    },
                    accounts: {},
                    transactions: {},
                    transactionsStatus: {},
                    blocks: {},
                    blocksMeta: {},
                    entry: {},
                    commitment: CommitmentLevel.PROCESSED,
                    accountsDataSlice: []
                }, (err: any) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });

            this.isConnected = true;
            console.log(`🔌 Conectado ao Yellowstone gRPC com sucesso! Escutando slots...`);
        } catch (error) {
            console.error('❌ Falha ao assinar gRPC. Tentando novamente...', error);
            setTimeout(() => this.subscribeToSlots(onSlotCallback), 5000);
        }
    }

    private static reconnect(onSlotCallback: (slot: string) => void) {
        this.isConnected = false;
        setTimeout(() => {
            console.log('🔄 Reconectando ao Yellowstone gRPC...');
            this.subscribeToSlots(onSlotCallback);
        }, 3000);
    }
}
