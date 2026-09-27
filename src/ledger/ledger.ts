import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { AccountConfig, DeploymentConfig, InstrumentConfig, InstrumentForm } from "../config";

export const SYSTEM_ACCOUNTS = {
    /** Counterparty for book-entry issuance and redemption. */
    ISSUANCE: "SYS:ISSUANCE",
    /** Counterparty for on-chain mints and burns; its negated balance is the ledger's view of token supply. */
    CHAIN_SUPPLY: "SYS:CHAIN_SUPPLY",
    /** Book-entry units immobilized to back tokens of HYBRID instruments. */
    TOKEN_VAULT: "SYS:TOKEN_VAULT",
} as const;

export type Location = "ONCHAIN" | "BOOK";
export type AccountKind = "CLIENT" | "SYSTEM" | "EXTERNAL";

export interface Account {
    id: string;
    name: string;
    kind: AccountKind;
    wallet: string | null;
}

export interface Instrument {
    id: string;
    symbol: string;
    name: string;
    isin: string | null;
    assetClass: string;
    form: InstrumentForm;
    decimals: number;
    tokenAddress: string | null;
}

export interface Posting {
    accountId: string;
    location: Location;
    quantity: bigint;
}

export interface JournalEntryInput {
    instrumentId: string;
    entryType: string;
    source: "CHAIN" | "BOOK";
    reference?: string | null;
    txHash?: string | null;
    logIndex?: number | null;
    blockNumber?: number | null;
    occurredAt: string;
    postings: Posting[];
}

export interface PositionRow {
    accountId: string;
    instrumentId: string;
    onchain: bigint;
    book: bigint;
}

export interface MovementRow {
    entryId: number;
    instrumentId: string;
    entryType: string;
    source: string;
    reference: string | null;
    txHash: string | null;
    blockNumber: number | null;
    occurredAt: string;
    location: Location;
    quantity: bigint;
}

export type InstructionStatus = "PENDING" | "SETTLED" | "CANCELLED" | "EXPIRED";

export interface SettlementInstruction {
    id: number;
    sellerAccount: string;
    buyerAccount: string;
    sellerWallet: string;
    buyerWallet: string;
    assetInstrument: string;
    assetQuantity: bigint;
    cashInstrument: string;
    cashQuantity: bigint;
    deadline: number;
    status: InstructionStatus;
    sellerAffirmed: boolean;
    buyerAffirmed: boolean;
    failedAttempts: number;
    lastFailureReason: string | null;
    updatedBlock: number;
}

export interface Anomaly {
    id: number;
    kind: string;
    detail: string;
    txHash: string | null;
    detectedAt: string;
}

const INT64_MAX = 2n ** 63n - 1n;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS instruments (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  isin TEXT,
  asset_class TEXT NOT NULL,
  form TEXT NOT NULL CHECK (form IN ('TOKENIZED', 'BOOK_ENTRY', 'HYBRID')),
  decimals INTEGER NOT NULL,
  token_address TEXT UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CLIENT', 'SYSTEM', 'EXTERNAL')),
  wallet TEXT UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  entry_type TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('CHAIN', 'BOOK')),
  reference TEXT,
  tx_hash TEXT,
  log_index INTEGER,
  block_number INTEGER,
  occurred_at TEXT NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE TABLE IF NOT EXISTS postings (
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  location TEXT NOT NULL CHECK (location IN ('ONCHAIN', 'BOOK')),
  quantity INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_postings_account ON postings(account_id);
CREATE INDEX IF NOT EXISTS idx_postings_entry ON postings(entry_id);
CREATE INDEX IF NOT EXISTS idx_entries_reference ON journal_entries(reference);
CREATE TABLE IF NOT EXISTS settlement_instructions (
  id INTEGER PRIMARY KEY,
  seller_account TEXT NOT NULL,
  buyer_account TEXT NOT NULL,
  seller_wallet TEXT NOT NULL,
  buyer_wallet TEXT NOT NULL,
  asset_instrument TEXT NOT NULL,
  asset_quantity INTEGER NOT NULL,
  cash_instrument TEXT NOT NULL,
  cash_quantity INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  status TEXT NOT NULL,
  seller_affirmed INTEGER NOT NULL DEFAULT 0,
  buyer_affirmed INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  last_failure_reason TEXT,
  updated_block INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  tx_hash TEXT,
  detected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS indexer_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

/**
 * Double-entry position ledger covering on-chain (tokenized) and book-entry holdings.
 * Every journal entry must net to zero per location, so positions can never be created from nothing.
 */
export class PositionLedger {
    readonly db: DatabaseSync;
    private txDepth = 0;

    constructor(file = ":memory:") {
        if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
        this.db.exec(SCHEMA);
    }

    close(): void {
        this.db.close();
    }

    transaction<T>(fn: () => T): T {
        if (this.txDepth > 0) return fn();
        this.db.exec("BEGIN IMMEDIATE");
        this.txDepth++;
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        } finally {
            this.txDepth--;
        }
    }

    /** Loads instruments, accounts and system accounts from a deployment. Safe to call repeatedly. */
    initialize(config: DeploymentConfig): void {
        this.transaction(() => {
            for (const i of config.instruments) this.upsertInstrument(i);
            for (const a of config.accounts) this.upsertAccount(a, "CLIENT");
            this.upsertAccount({ id: SYSTEM_ACCOUNTS.ISSUANCE, name: "Issuance (book-entry register)" }, "SYSTEM");
            this.upsertAccount({ id: SYSTEM_ACCOUNTS.CHAIN_SUPPLY, name: "On-chain supply" }, "SYSTEM");
            this.upsertAccount({ id: SYSTEM_ACCOUNTS.TOKEN_VAULT, name: "Token vault (immobilized book-entry units)" }, "SYSTEM");
            if (this.getState("lastBlock") === null) this.setState("lastBlock", String(config.deployBlock - 1));
            this.setState("deployBlock", String(config.deployBlock));
        });
    }

    upsertInstrument(i: InstrumentConfig): void {
        this.run(
            `INSERT INTO instruments (id, symbol, name, isin, asset_class, form, decimals, token_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, isin = excluded.isin,
         asset_class = excluded.asset_class, form = excluded.form, decimals = excluded.decimals,
         token_address = excluded.token_address`,
            i.id, i.symbol, i.name, i.isin ?? null, i.assetClass, i.form, i.decimals, i.tokenAddress ?? null,
        );
    }

    upsertAccount(a: AccountConfig, kind: AccountKind): void {
        this.run(
            `INSERT INTO accounts (id, name, kind, wallet) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, wallet = excluded.wallet`,
            a.id, a.name, kind, a.wallet ?? null,
        );
    }

    /** Wallets seen on-chain that are not onboarded accounts still get a ledger account, so nothing is untracked. */
    ensureExternalAccount(wallet: string): Account {
        const existing = this.getAccountByWallet(wallet);
        if (existing) return existing;
        const id = `EXT:${wallet.toLowerCase()}`;
        this.upsertAccount({ id, name: `External wallet ${wallet}`, wallet }, "EXTERNAL");
        return this.getAccount(id)!;
    }

    getAccount(id: string): Account | null {
        const row = this.get("SELECT * FROM accounts WHERE id = ?", id);
        return row ? toAccount(row) : null;
    }

    getAccountByWallet(wallet: string): Account | null {
        const row = this.get("SELECT * FROM accounts WHERE wallet = ?", wallet);
        return row ? toAccount(row) : null;
    }

    listAccounts(kind?: AccountKind): Account[] {
        const rows = kind
            ? this.all("SELECT * FROM accounts WHERE kind = ? ORDER BY id", kind)
            : this.all("SELECT * FROM accounts ORDER BY id");
        return rows.map(toAccount);
    }

    getInstrument(id: string): Instrument | null {
        const row = this.get("SELECT * FROM instruments WHERE id = ?", id);
        return row ? toInstrument(row) : null;
    }

    getInstrumentByToken(address: string): Instrument | null {
        const row = this.get("SELECT * FROM instruments WHERE token_address = ?", address);
        return row ? toInstrument(row) : null;
    }

    listInstruments(): Instrument[] {
        return this.all("SELECT * FROM instruments ORDER BY id").map(toInstrument);
    }

    /** Records a balanced journal entry. Returns null if the on-chain event was already recorded. */
    recordEntry(entry: JournalEntryInput): number | null {
        if (entry.postings.length === 0) throw new Error("Journal entry needs at least one posting");
        const net = new Map<Location, bigint>();
        for (const p of entry.postings) {
            if (p.quantity > INT64_MAX || p.quantity < -INT64_MAX) throw new Error("Quantity exceeds ledger precision");
            net.set(p.location, (net.get(p.location) ?? 0n) + p.quantity);
        }
        for (const [location, sum] of net) {
            if (sum !== 0n) throw new Error(`Unbalanced journal entry: ${location} postings net to ${sum}`);
        }

        return this.transaction(() => {
            const result = this.run(
                `INSERT OR IGNORE INTO journal_entries
           (instrument_id, entry_type, source, reference, tx_hash, log_index, block_number, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                entry.instrumentId, entry.entryType, entry.source, entry.reference ?? null,
                entry.txHash ?? null, entry.logIndex ?? null, entry.blockNumber ?? null, entry.occurredAt,
            );
            if (Number(result.changes) === 0) return null;
            const entryId = Number(result.lastInsertRowid);
            for (const p of entry.postings) {
                this.run(
                    "INSERT INTO postings (entry_id, account_id, location, quantity) VALUES (?, ?, ?, ?)",
                    entryId, p.accountId, p.location, p.quantity,
                );
            }
            return entryId;
        });
    }

    position(accountId: string, instrumentId: string, location: Location): bigint {
        const row = this.get(
            `SELECT COALESCE(SUM(p.quantity), 0) AS qty FROM postings p
       JOIN journal_entries e ON e.id = p.entry_id
       WHERE p.account_id = ? AND e.instrument_id = ? AND p.location = ?`,
            accountId, instrumentId, location,
        );
        return BigInt(row!.qty as bigint);
    }

    positions(accountId?: string): PositionRow[] {
        const filter = accountId ? "WHERE p.account_id = ?" : "";
        const params = accountId ? [accountId] : [];
        const rows = this.all(
            `SELECT p.account_id, e.instrument_id,
              SUM(CASE WHEN p.location = 'ONCHAIN' THEN p.quantity ELSE 0 END) AS onchain,
              SUM(CASE WHEN p.location = 'BOOK' THEN p.quantity ELSE 0 END) AS book
       FROM postings p JOIN journal_entries e ON e.id = p.entry_id
       ${filter}
       GROUP BY p.account_id, e.instrument_id
       HAVING onchain <> 0 OR book <> 0
       ORDER BY p.account_id, e.instrument_id`,
            ...params,
        );
        return rows.map((r) => ({
            accountId: r.account_id as string,
            instrumentId: r.instrument_id as string,
            onchain: BigInt(r.onchain as bigint),
            book: BigInt(r.book as bigint),
        }));
    }

    history(accountId: string, instrumentId?: string, limit = 50): MovementRow[] {
        const rows = this.all(
            `SELECT e.id AS entry_id, e.instrument_id, e.entry_type, e.source, e.reference, e.tx_hash,
              e.block_number, e.occurred_at, p.location, p.quantity
       FROM postings p JOIN journal_entries e ON e.id = p.entry_id
       WHERE p.account_id = ? ${instrumentId ? "AND e.instrument_id = ?" : ""}
       ORDER BY e.id DESC LIMIT ?`,
            ...(instrumentId ? [accountId, instrumentId, limit] : [accountId, limit]),
        );
        return rows.map((r) => ({
            entryId: Number(r.entry_id),
            instrumentId: r.instrument_id as string,
            entryType: r.entry_type as string,
            source: r.source as string,
            reference: (r.reference as string | null) ?? null,
            txHash: (r.tx_hash as string | null) ?? null,
            blockNumber: r.block_number === null ? null : Number(r.block_number),
            occurredAt: r.occurred_at as string,
            location: r.location as Location,
            quantity: BigInt(r.quantity as bigint),
        }));
    }

    /** Quantity immobilized in the vault by a TOKENIZE_LOCK entry with the given reference, or null. */
    lockedQuantity(instrumentId: string, reference: string): bigint | null {
        const row = this.get(
            `SELECT p.quantity FROM postings p JOIN journal_entries e ON e.id = p.entry_id
       WHERE e.entry_type = 'TOKENIZE_LOCK' AND e.instrument_id = ? AND e.reference = ? AND p.account_id = ?`,
            instrumentId, reference, SYSTEM_ACCOUNTS.TOKEN_VAULT,
        );
        return row ? BigInt(row.quantity as bigint) : null;
    }

    upsertInstruction(i: SettlementInstruction): void {
        this.run(
            `INSERT INTO settlement_instructions
         (id, seller_account, buyer_account, seller_wallet, buyer_wallet, asset_instrument, asset_quantity,
          cash_instrument, cash_quantity, deadline, status, seller_affirmed, buyer_affirmed, failed_attempts,
          last_failure_reason, updated_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, seller_affirmed = excluded.seller_affirmed,
         buyer_affirmed = excluded.buyer_affirmed, failed_attempts = excluded.failed_attempts,
         last_failure_reason = excluded.last_failure_reason, updated_block = excluded.updated_block`,
            i.id, i.sellerAccount, i.buyerAccount, i.sellerWallet, i.buyerWallet, i.assetInstrument, i.assetQuantity,
            i.cashInstrument, i.cashQuantity, i.deadline, i.status, i.sellerAffirmed ? 1 : 0, i.buyerAffirmed ? 1 : 0,
            i.failedAttempts, i.lastFailureReason, i.updatedBlock,
        );
    }

    getInstruction(id: number): SettlementInstruction | null {
        const row = this.get("SELECT * FROM settlement_instructions WHERE id = ?", id);
        return row ? toInstruction(row) : null;
    }

    listInstructions(filter: { accountIds?: string[]; status?: InstructionStatus } = {}): SettlementInstruction[] {
        return this.all("SELECT * FROM settlement_instructions ORDER BY id")
            .map(toInstruction)
            .filter((i) => !filter.status || i.status === filter.status)
            .filter(
                (i) => !filter.accountIds || filter.accountIds.includes(i.sellerAccount) || filter.accountIds.includes(i.buyerAccount),
            );
    }

    recordAnomaly(kind: string, detail: string, txHash: string | null): void {
        this.run(
            "INSERT INTO anomalies (kind, detail, tx_hash, detected_at) VALUES (?, ?, ?, ?)",
            kind, detail, txHash, new Date().toISOString(),
        );
    }

    listAnomalies(): Anomaly[] {
        return this.all("SELECT * FROM anomalies ORDER BY id").map((r) => ({
            id: Number(r.id),
            kind: r.kind as string,
            detail: r.detail as string,
            txHash: (r.tx_hash as string | null) ?? null,
            detectedAt: r.detected_at as string,
        }));
    }

    getState(key: string): string | null {
        const row = this.get("SELECT value FROM indexer_state WHERE key = ?", key);
        return row ? (row.value as string) : null;
    }

    setState(key: string, value: string): void {
        this.run(
            "INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            key, value,
        );
    }

    private run(sql: string, ...params: SQLInputValue[]) {
        return this.db.prepare(sql).run(...params);
    }

    private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
        const stmt = this.db.prepare(sql);
        stmt.setReadBigInts(true);
        return stmt.get(...params) as Row | undefined;
    }

    private all(sql: string, ...params: SQLInputValue[]): Row[] {
        const stmt = this.db.prepare(sql);
        stmt.setReadBigInts(true);
        return stmt.all(...params) as Row[];
    }
}

function toAccount(r: Row): Account {
    return { id: r.id as string, name: r.name as string, kind: r.kind as AccountKind, wallet: (r.wallet as string | null) ?? null };
}

function toInstrument(r: Row): Instrument {
    return {
        id: r.id as string,
        symbol: r.symbol as string,
        name: r.name as string,
        isin: (r.isin as string | null) ?? null,
        assetClass: r.asset_class as string,
        form: r.form as InstrumentForm,
        decimals: Number(r.decimals),
        tokenAddress: (r.token_address as string | null) ?? null,
    };
}

function toInstruction(r: Row): SettlementInstruction {
    return {
        id: Number(r.id),
        sellerAccount: r.seller_account as string,
        buyerAccount: r.buyer_account as string,
        sellerWallet: r.seller_wallet as string,
        buyerWallet: r.buyer_wallet as string,
        assetInstrument: r.asset_instrument as string,
        assetQuantity: BigInt(r.asset_quantity as bigint),
        cashInstrument: r.cash_instrument as string,
        cashQuantity: BigInt(r.cash_quantity as bigint),
        deadline: Number(r.deadline),
        status: r.status as InstructionStatus,
        sellerAffirmed: Number(r.seller_affirmed) === 1,
        buyerAffirmed: Number(r.buyer_affirmed) === 1,
        failedAttempts: Number(r.failed_attempts),
        lastFailureReason: (r.last_failure_reason as string | null) ?? null,
        updatedBlock: Number(r.updated_block),
    };
}
