import type { Provider } from "ethers";
import { dvpAt, SETTLEMENT_FAILURE_REASONS } from "./chain/contracts";
import { formatQty } from "./format";
import type { PositionLedger, SettlementInstruction } from "./ledger/ledger";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface SettlementRisk {
  instructionId: number;
  seller: string;
  buyer: string;
  asset: { instrumentId: string; quantity: string };
  cash: { instrumentId: string; quantity: string };
  deadline: string;
  minutesToDeadline: number;
  failedAttempts: number;
  lastFailureReason: string | null;
  wouldFailWith: string | null;
  riskLevel: RiskLevel;
  issues: string[];
  suggestedActions: string[];
}

export interface SettlementRiskReport {
  asOfBlock: number;
  asOfTime: string;
  pendingInstructions: number;
  byRiskLevel: Record<RiskLevel, number>;
  instructions: SettlementRisk[];
}

const HIGH_RISK_WINDOW_MINUTES = 60;

/**
 * Flags pending DvP instructions likely to fail. The on-chain dry run (checkSettlement) is authoritative;
 * ledger positions add the shortfall size and whether it can be covered from book-entry holdings.
 */
export async function assessSettlementRisk(
  ledger: PositionLedger,
  provider: Provider,
  dvpAddress: string,
  options: { accountIds?: string[] } = {},
): Promise<SettlementRiskReport> {
  const dvp = dvpAt(dvpAddress, provider);
  const block = (await provider.getBlock("latest"))!;
  const now = Number(block.timestamp);
  const pending = ledger.listInstructions({ status: "PENDING", accountIds: options.accountIds });

  const visible = (accountId: string) => !options.accountIds || options.accountIds.includes(accountId);
  const instructions: SettlementRisk[] = [];
  for (const ins of pending) {
    const code = Number(await dvp.checkSettlement(ins.id));
    instructions.push(assess(ledger, ins, code, now, visible));
  }

  const byRiskLevel: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  for (const r of instructions) byRiskLevel[r.riskLevel]++;
  instructions.sort((a, b) => rank(b.riskLevel) - rank(a.riskLevel) || a.minutesToDeadline - b.minutesToDeadline);

  return {
    asOfBlock: block.number,
    asOfTime: new Date(now * 1000).toISOString(),
    pendingInstructions: instructions.length,
    byRiskLevel,
    instructions,
  };
}

function assess(
  ledger: PositionLedger,
  ins: SettlementInstruction,
  code: number,
  now: number,
  visible: (accountId: string) => boolean,
): SettlementRisk {
  const asset = ledger.getInstrument(ins.assetInstrument);
  const cash = ledger.getInstrument(ins.cashInstrument);
  const assetDecimals = asset?.decimals ?? 0;
  const cashDecimals = cash?.decimals ?? 0;
  const minutesToDeadline = Math.floor((ins.deadline - now) / 60);
  const issues: string[] = [];
  const actions: string[] = [];

  if (!ins.sellerAffirmed) {
    issues.push(`Seller ${ins.sellerAccount} has not affirmed the instruction.`);
    actions.push(`Chase ${ins.sellerAccount} to affirm.`);
  }
  if (!ins.buyerAffirmed) {
    issues.push(`Buyer ${ins.buyerAccount} has not affirmed the instruction.`);
    actions.push(`Chase ${ins.buyerAccount} to affirm.`);
  }

  const reason = code === 0 ? null : SETTLEMENT_FAILURE_REASONS[code] ?? `UNKNOWN_${code}`;

  // Counterparty holdings are only disclosed to callers scoped to that counterparty.
  if (!visible(ins.sellerAccount) && reason === "SELLER_INSUFFICIENT_ASSET") {
    issues.push(`Seller ${ins.sellerAccount} cannot deliver the asset leg (counterparty holdings not disclosed).`);
    actions.push(`Contact ${ins.sellerAccount} about its delivery shortfall.`);
  }
  if (!visible(ins.buyerAccount) && reason === "BUYER_INSUFFICIENT_CASH") {
    issues.push(`Buyer ${ins.buyerAccount} cannot fund the cash leg (counterparty holdings not disclosed).`);
    actions.push(`Contact ${ins.buyerAccount} about its funding shortfall.`);
  }

  const sellerHolds = ledger.position(ins.sellerAccount, ins.assetInstrument, "ONCHAIN");
  if (visible(ins.sellerAccount) && sellerHolds < ins.assetQuantity) {
    const shortfall = ins.assetQuantity - sellerHolds;
    issues.push(
      `Seller short ${formatQty(shortfall, assetDecimals)} ${ins.assetInstrument} on-chain ` +
        `(holds ${formatQty(sellerHolds, assetDecimals)}, needs ${formatQty(ins.assetQuantity, assetDecimals)}).`,
    );
    const sellerBook = ledger.position(ins.sellerAccount, ins.assetInstrument, "BOOK");
    if (asset?.form === "HYBRID" && sellerBook >= shortfall) {
      actions.push(`Tokenize ${formatQty(shortfall, assetDecimals)} of the seller's ${formatQty(sellerBook, assetDecimals)} book-entry units.`);
    } else {
      actions.push("Seller to source the missing units, or agree a partial settlement.");
    }
  }

  const buyerHolds = ledger.position(ins.buyerAccount, ins.cashInstrument, "ONCHAIN");
  if (visible(ins.buyerAccount) && buyerHolds < ins.cashQuantity) {
    const shortfall = ins.cashQuantity - buyerHolds;
    issues.push(
      `Buyer short ${formatQty(shortfall, cashDecimals)} ${ins.cashInstrument} ` +
        `(holds ${formatQty(buyerHolds, cashDecimals)}, needs ${formatQty(ins.cashQuantity, cashDecimals)}).`,
    );
    actions.push(`Arrange ${formatQty(shortfall, cashDecimals)} ${ins.cashInstrument} funding for ${ins.buyerAccount}.`);
  }

  if (reason === "ASSET_ALLOWANCE_MISSING") actions.push(`${ins.sellerAccount} must approve the DvP contract for the asset leg.`);
  if (reason === "CASH_ALLOWANCE_MISSING") actions.push(`${ins.buyerAccount} must approve the DvP contract for the cash leg.`);
  if (reason === "ASSET_NOT_COMPLIANT" || reason === "CASH_NOT_COMPLIANT") {
    issues.push("A compliance control (KYC, frozen wallet or paused instrument) blocks one leg.");
    actions.push("Escalate to compliance; do not retry until resolved.");
  }
  if (minutesToDeadline < 0) issues.push("Deadline has passed; the next settlement attempt will expire the instruction.");
  if (ins.failedAttempts > 0) issues.push(`${ins.failedAttempts} failed settlement attempt(s), last: ${ins.lastFailureReason}.`);
  if (reason === null) actions.push("Ready to settle.");

  let riskLevel: RiskLevel = "LOW";
  if (reason !== null || ins.failedAttempts > 0) riskLevel = "MEDIUM";
  if (reason !== null && minutesToDeadline < HIGH_RISK_WINDOW_MINUTES) riskLevel = "HIGH";

  return {
    instructionId: ins.id,
    seller: ins.sellerAccount,
    buyer: ins.buyerAccount,
    asset: { instrumentId: ins.assetInstrument, quantity: formatQty(ins.assetQuantity, assetDecimals) },
    cash: { instrumentId: ins.cashInstrument, quantity: formatQty(ins.cashQuantity, cashDecimals) },
    deadline: new Date(ins.deadline * 1000).toISOString(),
    minutesToDeadline,
    failedAttempts: ins.failedAttempts,
    lastFailureReason: ins.lastFailureReason,
    wouldFailWith: reason,
    riskLevel,
    issues,
    suggestedActions: actions,
  };
}

const rank = (level: RiskLevel) => ({ LOW: 0, MEDIUM: 1, HIGH: 2 })[level];
