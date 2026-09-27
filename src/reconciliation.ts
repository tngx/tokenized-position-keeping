import type { Provider } from "ethers";
import { tokenAt } from "./chain/contracts";
import { formatQty } from "./format";
import { SYSTEM_ACCOUNTS, type Anomaly, type PositionLedger } from "./ledger/ledger";

export type BreakKind = "POSITION_MISMATCH" | "TIMING" | "SUPPLY_MISMATCH" | "BACKING_MISMATCH";

export interface ReconciliationBreak {
  kind: BreakKind;
  instrumentId: string;
  accountId?: string;
  ledger: string;
  chain: string;
  difference: string;
  explanation: string;
}

export interface ReconciliationResult {
  status: "CLEAN" | "BREAKS";
  ledgerSyncedToBlock: number;
  chainHeadBlock: number;
  positionsChecked: number;
  breaks: ReconciliationBreak[];
  anomalies: Anomaly[];
}

/**
 * Compares the ledger with the chain. Each wallet balance is read twice: at the ledger's last indexed block
 * (a genuine break if it differs) and at the chain head (a timing break: activity the ledger has not yet indexed).
 */
export async function reconcile(
  ledger: PositionLedger,
  provider: Provider,
  options: { accountIds?: string[] } = {},
): Promise<ReconciliationResult> {
  const synced = Number(ledger.getState("lastBlock") ?? "-1");
  const deployBlock = Number(ledger.getState("deployBlock") ?? "0");
  const head = await provider.getBlockNumber();
  const breaks: ReconciliationBreak[] = [];
  let positionsChecked = 0;

  const holders = ledger
    .listAccounts()
    .filter((a) => a.wallet && a.kind !== "SYSTEM")
    .filter((a) => !options.accountIds || options.accountIds.includes(a.id));

  for (const instrument of ledger.listInstruments()) {
    if (!instrument.tokenAddress) continue;
    const token = tokenAt(instrument.tokenAddress, provider);
    const fmt = (q: bigint) => formatQty(q, instrument.decimals);
    const readAt = async (fn: "balanceOf" | "totalSupply", block: number, ...args: string[]): Promise<bigint> =>
      block < deployBlock ? 0n : ((await token[fn](...args, { blockTag: block })) as bigint);

    for (const account of holders) {
      const inLedger = ledger.position(account.id, instrument.id, "ONCHAIN");
      const atSynced = await readAt("balanceOf", synced, account.wallet!);
      const atHead = head === synced ? atSynced : await readAt("balanceOf", head, account.wallet!);
      if (inLedger === 0n && atHead === 0n) continue;
      positionsChecked++;

      if (inLedger !== atSynced) {
        breaks.push({
          kind: "POSITION_MISMATCH",
          instrumentId: instrument.id,
          accountId: account.id,
          ledger: fmt(inLedger),
          chain: fmt(atSynced),
          difference: fmt(atSynced - inLedger),
          explanation: `Ledger disagrees with the chain at block ${synced}, the block it claims to be synced to. Investigate before relying on this position.`,
        });
      } else if (inLedger !== atHead) {
        breaks.push({
          kind: "TIMING",
          instrumentId: instrument.id,
          accountId: account.id,
          ledger: fmt(inLedger),
          chain: fmt(atHead),
          difference: fmt(atHead - inLedger),
          explanation: `On-chain activity after block ${synced} is not yet indexed. Resolves on the next sync.`,
        });
      }
    }

    const supply = await readAt("totalSupply", synced);
    const ledgerSupply = -ledger.position(SYSTEM_ACCOUNTS.CHAIN_SUPPLY, instrument.id, "ONCHAIN");
    if (ledgerSupply !== supply) {
      breaks.push({
        kind: "SUPPLY_MISMATCH",
        instrumentId: instrument.id,
        ledger: fmt(ledgerSupply),
        chain: fmt(supply),
        difference: fmt(supply - ledgerSupply),
        explanation: "Total on-chain supply differs from minted-minus-burned in the ledger.",
      });
    }

    if (instrument.form === "HYBRID") {
      const vault = ledger.position(SYSTEM_ACCOUNTS.TOKEN_VAULT, instrument.id, "BOOK");
      if (vault !== supply) {
        breaks.push({
          kind: "BACKING_MISMATCH",
          instrumentId: instrument.id,
          ledger: fmt(vault),
          chain: fmt(supply),
          difference: fmt(supply - vault),
          explanation: "Book-entry units immobilized in the token vault must equal on-chain supply (1:1 backing).",
        });
      }
    }
  }

  return {
    status: breaks.length === 0 ? "CLEAN" : "BREAKS",
    ledgerSyncedToBlock: synced,
    chainHeadBlock: head,
    positionsChecked,
    breaks,
    anomalies: ledger.listAnomalies(),
  };
}
