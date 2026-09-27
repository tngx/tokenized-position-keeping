import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { dvpAt, registryAt, tokenAt } from "../src/chain/contracts";
import type { DeploymentConfig } from "../src/config";
import { deployPlatform } from "../src/deploy";
import { ChainIndexer } from "../src/indexer";
import { PositionLedger, SYSTEM_ACCOUNTS } from "../src/ledger/ledger";
import { PlatformOperations } from "../src/operations";
import { reconcile } from "../src/reconciliation";
import { assessSettlementRisk } from "../src/settlementRisk";

describe("Position-keeping service", () => {
  let issuer: HardhatEthersSigner, fundA: HardhatEthersSigner, fundB: HardhatEthersSigner;
  let config: DeploymentConfig;
  let ledger: PositionLedger;
  let indexer: ChainIndexer;
  let ops: PlatformOperations;

  const bondAddr = () => config.instruments.find((i) => i.id === "BOND")!.tokenAddress!;
  const eurAddr = () => config.instruments.find((i) => i.id === "EUR")!.tokenAddress!;
  const pos = (account: string, instrument: string) => ({
    onchain: ledger.position(account, instrument, "ONCHAIN"),
    book: ledger.position(account, instrument, "BOOK"),
  });

  before(async () => {
    [issuer, fundA, fundB] = await ethers.getSigners();
    config = await deployPlatform(
      issuer,
      [
        { id: "BOND", symbol: "BND", name: "Test Bond", isin: "DE000TEST001", assetClass: "BOND", form: "HYBRID", decimals: 0 },
        { id: "EUR", symbol: "tEUR", name: "Tokenized EUR", assetClass: "CASH", form: "TOKENIZED", decimals: 2 },
      ],
      [
        { id: "fund-a", name: "Fund A", wallet: fundA.address },
        { id: "fund-b", name: "Fund B", wallet: fundB.address },
      ],
      "hardhat",
    );
    const registry = registryAt(config.contracts.identityRegistry, issuer);
    await (await registry.registerInvestor(fundA.address, 276)).wait();
    await (await registry.registerInvestor(fundB.address, 276)).wait();

    ledger = new PositionLedger(":memory:");
    ledger.initialize(config);
    indexer = new ChainIndexer(ledger, ethers.provider, config);
    ops = new PlatformOperations(ledger, issuer);
  });

  after(() => ledger.close());

  it("keeps hybrid positions across book-entry and chain, and settles DvP into the ledger", async () => {
    ops.bookIssue("BOND", "fund-a", 1_000n);
    await ops.tokenize("BOND", "fund-a", 400n);
    await ops.issueOnChain("EUR", "fund-b", 50_000_00n);

    const dvp = dvpAt(config.contracts.dvp, fundA);
    const deadline = (await time.latest()) + 86_400;
    await (await dvp.createInstruction(fundA.address, fundB.address, bondAddr(), 100, eurAddr(), 10_000_00, deadline)).wait();
    await (await dvpAt(config.contracts.dvp, fundB).affirm(1)).wait();
    await (await tokenAt(bondAddr(), fundA).approve(config.contracts.dvp, 100)).wait();
    await (await tokenAt(eurAddr(), fundB).approve(config.contracts.dvp, 10_000_00)).wait();
    await (await dvp.settle(1)).wait();

    await indexer.sync();

    expect(pos("fund-a", "BOND")).to.deep.equal({ onchain: 300n, book: 600n });
    expect(pos("fund-b", "BOND")).to.deep.equal({ onchain: 100n, book: 0n });
    expect(pos("fund-a", "EUR").onchain).to.equal(10_000_00n);
    expect(pos("fund-b", "EUR").onchain).to.equal(40_000_00n);
    expect(ledger.position(SYSTEM_ACCOUNTS.TOKEN_VAULT, "BOND", "BOOK")).to.equal(400n);
    expect(ledger.getInstruction(1)!.status).to.equal("SETTLED");
    expect(ledger.history("fund-b", "BOND")[0].entryType).to.equal("DVP_SETTLEMENT");

    const recon = await reconcile(ledger, ethers.provider);
    expect(recon.status).to.equal("CLEAN");
  });

  it("releases book-entry units when tokens are detokenized", async () => {
    await ops.detokenize("BOND", "fund-b", 100n);
    await indexer.sync();

    expect(pos("fund-b", "BOND")).to.deep.equal({ onchain: 0n, book: 100n });
    expect(ledger.position(SYSTEM_ACCOUNTS.TOKEN_VAULT, "BOND", "BOOK")).to.equal(300n);
    expect((await reconcile(ledger, ethers.provider)).status).to.equal("CLEAN");
  });

  it("classifies unindexed chain activity as a timing break that clears on sync", async () => {
    await (await tokenAt(bondAddr(), fundA).transfer(fundB.address, 50)).wait();

    const before = await reconcile(ledger, ethers.provider);
    expect(before.breaks.map((b) => b.kind)).to.deep.equal(["TIMING", "TIMING"]);

    await indexer.sync();
    expect((await reconcile(ledger, ethers.provider)).status).to.equal("CLEAN");
  });

  it("detects a genuine break when the ledger disagrees with the chain", async () => {
    ledger.recordEntry({
      instrumentId: "BOND",
      entryType: "MANUAL_ADJUSTMENT",
      source: "CHAIN",
      occurredAt: new Date().toISOString(),
      postings: [
        { accountId: "fund-a", location: "ONCHAIN", quantity: 5n },
        { accountId: SYSTEM_ACCOUNTS.CHAIN_SUPPLY, location: "ONCHAIN", quantity: -5n },
      ],
    });

    const recon = await reconcile(ledger, ethers.provider);
    expect(recon.breaks.map((b) => b.kind)).to.have.members(["POSITION_MISMATCH", "SUPPLY_MISMATCH"]);
    const mismatch = recon.breaks.find((b) => b.kind === "POSITION_MISMATCH")!;
    expect(mismatch).to.include({ accountId: "fund-a", ledger: "255", chain: "250", difference: "-5" });

    ledger.recordEntry({
      instrumentId: "BOND",
      entryType: "MANUAL_ADJUSTMENT_REVERSAL",
      source: "CHAIN",
      occurredAt: new Date().toISOString(),
      postings: [
        { accountId: "fund-a", location: "ONCHAIN", quantity: -5n },
        { accountId: SYSTEM_ACCOUNTS.CHAIN_SUPPLY, location: "ONCHAIN", quantity: 5n },
      ],
    });
    expect((await reconcile(ledger, ethers.provider)).status).to.equal("CLEAN");
  });

  it("rejects unbalanced journal entries", () => {
    expect(() =>
      ledger.recordEntry({
        instrumentId: "BOND",
        entryType: "BAD",
        source: "BOOK",
        occurredAt: new Date().toISOString(),
        postings: [{ accountId: "fund-a", location: "BOOK", quantity: 1n }],
      }),
    ).to.throw(/Unbalanced/);
  });

  it("flags a pending instruction that will fail near its deadline as high risk", async () => {
    const deadline = (await time.latest()) + 30 * 60;
    await (await dvpAt(config.contracts.dvp, fundB).createInstruction(
      fundA.address, fundB.address, bondAddr(), 500, eurAddr(), 60_000_00, deadline,
    )).wait();
    await indexer.sync();

    const report = await assessSettlementRisk(ledger, ethers.provider, config.contracts.dvp);
    const risk = report.instructions.find((r) => r.instructionId === 2)!;
    expect(risk.riskLevel).to.equal("HIGH");
    expect(risk.wouldFailWith).to.equal("NOT_AFFIRMED");
    expect(risk.issues.join(" ")).to.match(/Seller short 250 BOND/).and.match(/Buyer short 20000.00 EUR/);
    expect(risk.suggestedActions.join(" ")).to.match(/Tokenize 250 of the seller's 600 book-entry units/);
  });

  it("does not disclose counterparty holdings outside the caller's scope", async () => {
    const report = await assessSettlementRisk(ledger, ethers.provider, config.contracts.dvp, { accountIds: ["fund-b"] });
    const text = report.instructions.find((r) => r.instructionId === 2)!.issues.join(" ");
    expect(text).to.match(/Buyer short 20000.00 EUR/);
    expect(text).not.to.match(/Seller short/);
  });

  it("re-indexing from scratch is idempotent", async () => {
    const snapshot = ledger.positions();
    ledger.setState("lastBlock", String(config.deployBlock - 1));
    await indexer.sync();
    expect(ledger.positions()).to.deep.equal(snapshot);
  });
});
