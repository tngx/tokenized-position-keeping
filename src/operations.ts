import { hexlify, randomBytes, type Signer } from "ethers";
import { tokenAt } from "./chain/contracts";
import { SYSTEM_ACCOUNTS, type Instrument, type PositionLedger } from "./ledger/ledger";

/** Issuer/operator actions: book-entry register movements and bridging HYBRID instruments on and off chain. */
export class PlatformOperations {
  constructor(
    private readonly ledger: PositionLedger,
    private readonly issuer: Signer,
  ) {}

  bookIssue(instrumentId: string, accountId: string, quantity: bigint, reference?: string): void {
    this.requireForm(instrumentId, ["BOOK_ENTRY", "HYBRID"]);
    this.ledger.recordEntry({
      instrumentId,
      entryType: "BOOK_ISSUE",
      source: "BOOK",
      reference: reference ?? null,
      occurredAt: new Date().toISOString(),
      postings: [
        { accountId, location: "BOOK", quantity },
        { accountId: SYSTEM_ACCOUNTS.ISSUANCE, location: "BOOK", quantity: -quantity },
      ],
    });
  }

  bookTransfer(instrumentId: string, fromAccountId: string, toAccountId: string, quantity: bigint): void {
    this.requireForm(instrumentId, ["BOOK_ENTRY", "HYBRID"]);
    this.ledger.transaction(() => {
      this.requireBookBalance(instrumentId, fromAccountId, quantity);
      this.ledger.recordEntry({
        instrumentId,
        entryType: "BOOK_TRANSFER",
        source: "BOOK",
        occurredAt: new Date().toISOString(),
        postings: [
          { accountId: fromAccountId, location: "BOOK", quantity: -quantity },
          { accountId: toAccountId, location: "BOOK", quantity },
        ],
      });
    });
  }

  /** Native issuance of a TOKENIZED instrument directly on-chain. */
  async issueOnChain(instrumentId: string, accountId: string, quantity: bigint): Promise<string> {
    const instrument = this.requireForm(instrumentId, ["TOKENIZED"]);
    const ref = hexlify(randomBytes(32));
    const tx = await tokenAt(instrument.tokenAddress!, this.issuer).tokenize(this.walletOf(accountId), quantity, ref);
    await tx.wait();
    return tx.hash as string;
  }

  /**
   * Moves HYBRID units from the book-entry register onto the chain. Units are locked in the vault first;
   * if the mint fails the lock is reversed, so the book can never show units as both held and tokenized.
   */
  async tokenize(instrumentId: string, accountId: string, quantity: bigint): Promise<{ ref: string; txHash: string }> {
    const instrument = this.requireForm(instrumentId, ["HYBRID"]);
    const wallet = this.walletOf(accountId);
    const ref = hexlify(randomBytes(32)).toLowerCase();

    this.ledger.transaction(() => {
      this.requireBookBalance(instrumentId, accountId, quantity);
      this.ledger.recordEntry({
        instrumentId,
        entryType: "TOKENIZE_LOCK",
        source: "BOOK",
        reference: ref,
        occurredAt: new Date().toISOString(),
        postings: [
          { accountId, location: "BOOK", quantity: -quantity },
          { accountId: SYSTEM_ACCOUNTS.TOKEN_VAULT, location: "BOOK", quantity },
        ],
      });
    });

    try {
      const tx = await tokenAt(instrument.tokenAddress!, this.issuer).tokenize(wallet, quantity, ref);
      await tx.wait();
      return { ref, txHash: tx.hash as string };
    } catch (err) {
      this.ledger.recordEntry({
        instrumentId,
        entryType: "TOKENIZE_UNLOCK",
        source: "BOOK",
        reference: ref,
        occurredAt: new Date().toISOString(),
        postings: [
          { accountId: SYSTEM_ACCOUNTS.TOKEN_VAULT, location: "BOOK", quantity: -quantity },
          { accountId, location: "BOOK", quantity },
        ],
      });
      throw err;
    }
  }

  /** Burns HYBRID tokens; the indexer releases the matching vault units back to the holder's book-entry position. */
  async detokenize(instrumentId: string, accountId: string, quantity: bigint): Promise<{ ref: string; txHash: string }> {
    const instrument = this.requireForm(instrumentId, ["HYBRID"]);
    const ref = hexlify(randomBytes(32)).toLowerCase();
    const tx = await tokenAt(instrument.tokenAddress!, this.issuer).detokenize(this.walletOf(accountId), quantity, ref);
    await tx.wait();
    return { ref, txHash: tx.hash as string };
  }

  private requireForm(instrumentId: string, forms: Instrument["form"][]): Instrument {
    const instrument = this.ledger.getInstrument(instrumentId);
    if (!instrument) throw new Error(`Unknown instrument ${instrumentId}`);
    if (!forms.includes(instrument.form)) {
      throw new Error(`${instrumentId} is ${instrument.form}; operation requires ${forms.join(" or ")}`);
    }
    return instrument;
  }

  private requireBookBalance(instrumentId: string, accountId: string, quantity: bigint): void {
    const held = this.ledger.position(accountId, instrumentId, "BOOK");
    if (held < quantity) throw new Error(`${accountId} holds ${held} ${instrumentId} in the book, needs ${quantity}`);
  }

  private walletOf(accountId: string): string {
    const wallet = this.ledger.getAccount(accountId)?.wallet;
    if (!wallet) throw new Error(`Account ${accountId} has no wallet`);
    return wallet;
  }
}
