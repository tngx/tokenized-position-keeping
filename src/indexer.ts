import { Interface, ZeroAddress, type Log, type LogDescription, type Provider } from "ethers";
import { loadArtifact, SETTLEMENT_FAILURE_REASONS } from "./chain/contracts";
import type { DeploymentConfig } from "./config";
import { SYSTEM_ACCOUNTS, type Instrument, type PositionLedger } from "./ledger/ledger";

export interface SyncResult {
    fromBlock: number;
    toBlock: number;
    eventsProcessed: number;
}

interface TxContext {
    settledInstruction: Map<string, bigint>;
    tokenizationRef: Map<string, string>;
    timestamps: Map<number, string>;
}

/**
 * Projects on-chain events into the position ledger. Idempotent (entries are keyed by tx hash and log index)
 * and serialized, so it can be called before every read to serve real-time positions.
 */
export class ChainIndexer {
    private readonly tokenIface = new Interface(loadArtifact("SecurityToken").abi);
    private readonly dvpIface = new Interface(loadArtifact("DvPSettlement").abi);
    private readonly dvpAddress: string;
    private readonly addresses: string[];
    private tail: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly ledger: PositionLedger,
        private readonly provider: Provider,
        config: DeploymentConfig,
        private readonly chunkSize = 2_000,
    ) {
        this.dvpAddress = config.contracts.dvp.toLowerCase();
        this.addresses = [
            config.contracts.dvp,
            ...config.instruments.flatMap((i) => (i.tokenAddress ? [i.tokenAddress] : [])),
        ];
    }

    get lastIndexedBlock(): number {
        return Number(this.ledger.getState("lastBlock") ?? "-1");
    }

    sync(toBlock?: number): Promise<SyncResult> {
        const run = this.tail.then(() => this.syncOnce(toBlock));
        this.tail = run.catch(() => undefined);
        return run;
    }

    private async syncOnce(toBlock?: number): Promise<SyncResult> {
        const head = toBlock ?? (await this.provider.getBlockNumber());
        const fromBlock = this.lastIndexedBlock + 1;
        let eventsProcessed = 0;

        for (let from = fromBlock; from <= head; from += this.chunkSize) {
            const to = Math.min(head, from + this.chunkSize - 1);
            const logs = await this.provider.getLogs({ address: this.addresses, fromBlock: from, toBlock: to });
            eventsProcessed += await this.apply(logs, to);
        }
        return { fromBlock, toBlock: Math.max(head, fromBlock - 1), eventsProcessed };
    }

    private async apply(logs: readonly Log[], toBlock: number): Promise<number> {
        const sorted = [...logs].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
        const parsed = sorted.map((log) => ({ log, event: this.parse(log) }));

        const ctx: TxContext = { settledInstruction: new Map(), tokenizationRef: new Map(), timestamps: new Map() };
        for (const { log, event } of parsed) {
            if (!event) continue;
            if (event.name === "Settled") ctx.settledInstruction.set(log.transactionHash, event.args.id as bigint);
            if (event.name === "Tokenized" || event.name === "Detokenized") {
                ctx.tokenizationRef.set(log.transactionHash, (event.args.ref as string).toLowerCase());
            }
        }
        for (const blockNumber of new Set(sorted.map((l) => l.blockNumber))) {
            const block = await this.provider.getBlock(blockNumber);
            ctx.timestamps.set(blockNumber, new Date(Number(block!.timestamp) * 1000).toISOString());
        }

        this.ledger.transaction(() => {
            for (const { log, event } of parsed) {
                if (event) this.handle(log, event, ctx);
            }
            this.ledger.setState("lastBlock", String(toBlock));
        });
        return parsed.filter((p) => p.event).length;
    }

    private parse(log: Log): LogDescription | null {
        const iface = log.address.toLowerCase() === this.dvpAddress ? this.dvpIface : this.tokenIface;
        return iface.parseLog({ topics: [...log.topics], data: log.data });
    }

    private handle(log: Log, event: LogDescription, ctx: TxContext): void {
        if (log.address.toLowerCase() === this.dvpAddress) {
            this.handleDvp(log, event);
            return;
        }
        const instrument = this.ledger.getInstrumentByToken(log.address);
        if (!instrument) return;
        const meta = {
            instrumentId: instrument.id,
            txHash: log.transactionHash,
            logIndex: log.index,
            blockNumber: log.blockNumber,
            occurredAt: ctx.timestamps.get(log.blockNumber)!,
        };

        switch (event.name) {
            case "Transfer":
                this.handleTransfer(instrument, event, ctx, meta);
                break;
            case "Tokenized":
                if (instrument.form === "HYBRID") this.checkTokenizationBacking(instrument, event, log.transactionHash);
                break;
            case "Detokenized":
                if (instrument.form === "HYBRID") {
                    const holder = this.accountFor(event.args.from as string);
                    this.ledger.recordEntry({
                        ...meta,
                        entryType: "DETOKENIZE_RELEASE",
                        source: "BOOK",
                        reference: (event.args.ref as string).toLowerCase(),
                        postings: [
                            { accountId: SYSTEM_ACCOUNTS.TOKEN_VAULT, location: "BOOK", quantity: -(event.args.amount as bigint) },
                            { accountId: holder, location: "BOOK", quantity: event.args.amount as bigint },
                        ],
                    });
                }
                break;
        }
    }

    private handleTransfer(
        instrument: Instrument,
        event: LogDescription,
        ctx: TxContext,
        meta: { instrumentId: string; txHash: string; logIndex: number; blockNumber: number; occurredAt: string },
    ): void {
        const from = event.args.from as string;
        const to = event.args.to as string;
        const value = event.args.value as bigint;
        const hybrid = instrument.form === "HYBRID";

        if (from === ZeroAddress) {
            this.ledger.recordEntry({
                ...meta,
                entryType: hybrid ? "TOKENIZE_MINT" : "ISSUE",
                source: "CHAIN",
                reference: ctx.tokenizationRef.get(meta.txHash) ?? null,
                postings: [
                    { accountId: this.accountFor(to), location: "ONCHAIN", quantity: value },
                    { accountId: SYSTEM_ACCOUNTS.CHAIN_SUPPLY, location: "ONCHAIN", quantity: -value },
                ],
            });
            return;
        }
        if (to === ZeroAddress) {
            this.ledger.recordEntry({
                ...meta,
                entryType: hybrid ? "DETOKENIZE_BURN" : "REDEEM",
                source: "CHAIN",
                reference: ctx.tokenizationRef.get(meta.txHash) ?? null,
                postings: [
                    { accountId: this.accountFor(from), location: "ONCHAIN", quantity: -value },
                    { accountId: SYSTEM_ACCOUNTS.CHAIN_SUPPLY, location: "ONCHAIN", quantity: value },
                ],
            });
            return;
        }
        const settled = ctx.settledInstruction.get(meta.txHash);
        this.ledger.recordEntry({
            ...meta,
            entryType: settled !== undefined ? "DVP_SETTLEMENT" : "TRANSFER",
            source: "CHAIN",
            reference: settled !== undefined ? `dvp:${settled}` : null,
            postings: [
                { accountId: this.accountFor(from), location: "ONCHAIN", quantity: -value },
                { accountId: this.accountFor(to), location: "ONCHAIN", quantity: value },
            ],
        });
    }

    /** A HYBRID mint must match a prior book-entry lock; anything else means tokens exist without backing. */
    private checkTokenizationBacking(instrument: Instrument, event: LogDescription, txHash: string): void {
        const ref = (event.args.ref as string).toLowerCase();
        const amount = event.args.amount as bigint;
        const locked = this.ledger.lockedQuantity(instrument.id, ref);
        if (locked === null) {
            this.ledger.recordAnomaly("UNBACKED_MINT", `${instrument.id}: ${amount} units minted without a book-entry lock (ref ${ref})`, txHash);
        } else if (locked !== amount) {
            this.ledger.recordAnomaly("LOCK_AMOUNT_MISMATCH", `${instrument.id}: locked ${locked}, minted ${amount} (ref ${ref})`, txHash);
        }
    }

    private handleDvp(log: Log, event: LogDescription): void {
        const id = Number(event.args.id as bigint);
        if (event.name === "InstructionCreated") {
            const seller = event.args.seller as string;
            const buyer = event.args.buyer as string;
            this.ledger.upsertInstruction({
                id,
                sellerAccount: this.accountFor(seller),
                buyerAccount: this.accountFor(buyer),
                sellerWallet: seller,
                buyerWallet: buyer,
                assetInstrument: this.ledger.getInstrumentByToken(event.args.asset as string)?.id ?? `UNKNOWN:${event.args.asset}`,
                assetQuantity: event.args.assetAmount as bigint,
                cashInstrument: this.ledger.getInstrumentByToken(event.args.cash as string)?.id ?? `UNKNOWN:${event.args.cash}`,
                cashQuantity: event.args.cashAmount as bigint,
                deadline: Number(event.args.deadline as bigint),
                status: "PENDING",
                sellerAffirmed: false,
                buyerAffirmed: false,
                failedAttempts: 0,
                lastFailureReason: null,
                updatedBlock: log.blockNumber,
            });
            return;
        }

        const current = this.ledger.getInstruction(id);
        if (!current) return;
        const next = { ...current, updatedBlock: log.blockNumber };
        switch (event.name) {
            case "Affirmed":
                if ((event.args.party as string).toLowerCase() === current.sellerWallet.toLowerCase()) next.sellerAffirmed = true;
                else next.buyerAffirmed = true;
                break;
            case "Settled":
                next.status = "SETTLED";
                break;
            case "SettlementFailed":
                next.failedAttempts += 1;
                next.lastFailureReason = SETTLEMENT_FAILURE_REASONS[Number(event.args.reason)] ?? `UNKNOWN_${event.args.reason}`;
                break;
            case "Cancelled":
                next.status = "CANCELLED";
                break;
            case "Expired":
                next.status = "EXPIRED";
                break;
            default:
                return;
        }
        this.ledger.upsertInstruction(next);
    }

    private accountFor(wallet: string): string {
        return (this.ledger.getAccountByWallet(wallet) ?? this.ledger.ensureExternalAccount(wallet)).id;
    }
}
