import fs from "node:fs";
import { ethers } from "hardhat";
import { dvpAt, registryAt, tokenAt, COMPLIANCE_CODES } from "../src/chain/contracts";
import { DEFAULT_DB_PATH, saveDeployment } from "../src/config";
import { deployPlatform, type InstrumentSpec } from "../src/deploy";
import { formatQty } from "../src/format";
import { ChainIndexer } from "../src/indexer";
import { PositionLedger } from "../src/ledger/ledger";
import { PlatformOperations } from "../src/operations";
import { reconcile } from "../src/reconciliation";
import { assessSettlementRisk } from "../src/settlementRisk";

// All names and ISINs are fictional.
const INSTRUMENTS: InstrumentSpec[] = [
    { id: "ACME-2030", symbol: "ACME30", name: "ACME AG 3.5% Bond 2030", isin: "DE000DEMO001", assetClass: "BOND", form: "HYBRID", decimals: 0 },
    { id: "BAV-2031", symbol: "BAV31", name: "Bavaria State Bond 2031", isin: "DE000DEMO002", assetClass: "BOND", form: "BOOK_ENTRY", decimals: 0 },
    { id: "NWGF", symbol: "NWGF", name: "Nordwind Green Fund (units)", isin: "LU000DEMO003", assetClass: "FUND", form: "TOKENIZED", decimals: 0 },
    { id: "tEUR", symbol: "tEUR", name: "Tokenized EUR Deposit", assetClass: "CASH", form: "TOKENIZED", decimals: 2 },
];

const step = (title: string) => console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 70 - title.length))}`);

function resetDatabase() {
    for (const suffix of ["", "-wal", "-shm"]) {
        const file = DEFAULT_DB_PATH + suffix;
        try {
            fs.rmSync(file, { force: true });
        } catch {
            throw new Error(`Cannot delete ${file}. Stop the MCP server (it holds the database open) and re-run.`);
        }
    }
}

async function main() {
    const [issuer, fundA, fundB, bankC, unverified] = await ethers.getSigners();
    resetDatabase();

    step("1. Deploy registry, DvP contract and tokens");
    const config = await deployPlatform(issuer, INSTRUMENTS, [
        { id: "fund-a", name: "Alpine Asset Management — Fund A", wallet: fundA.address },
        { id: "fund-b", name: "Isar Pension Fund", wallet: fundB.address },
        { id: "bank-c", name: "Lakeside Bank (custodian)", wallet: bankC.address },
    ]);
    saveDeployment(config);
    for (const i of config.instruments) console.log(`  ${i.id.padEnd(10)} ${i.form.padEnd(10)} ${i.tokenAddress ?? "(book-entry only)"}`);

    const ledger = new PositionLedger(DEFAULT_DB_PATH);
    ledger.initialize(config);
    const indexer = new ChainIndexer(ledger, ethers.provider, config);
    const ops = new PlatformOperations(ledger, issuer);
    const token = (id: string) => config.instruments.find((i) => i.id === id)!.tokenAddress!;

    step("2. KYC: register investor wallets");
    const registry = registryAt(config.contracts.identityRegistry, issuer);
    for (const [wallet, country] of [[fundA, 276], [fundB, 276], [bankC, 756]] as const) {
        await (await registry.registerInvestor(wallet.address, country)).wait();
    }
    console.log(`  verified: fund-a, fund-b, bank-c  |  not verified: ${unverified.address}`);

    step("3. Book-entry issuance in the register");
    ops.bookIssue("ACME-2030", "fund-a", 10_000n);
    ops.bookIssue("BAV-2031", "fund-b", 5_000n);
    console.log("  fund-a: 10,000 ACME-2030 (book)  |  fund-b: 5,000 BAV-2031 (book)");

    step("4. Tokenize 4,000 ACME-2030 for fund-a (lock in vault, then mint)");
    await ops.tokenize("ACME-2030", "fund-a", 4_000n);

    step("5. Native on-chain issuance");
    await ops.issueOnChain("tEUR", "fund-b", 1_000_000_00n);
    await ops.issueOnChain("tEUR", "bank-c", 250_000_00n);
    await ops.issueOnChain("NWGF", "bank-c", 500n);
    console.log("  tEUR: fund-b 1,000,000.00, bank-c 250,000.00  |  NWGF: bank-c 500 units");

    step("6. DvP settlement");
    const now = async () => (await ethers.provider.getBlock("latest"))!.timestamp;
    const dvpAddr = config.contracts.dvp;

    // #1 settles: fund-a delivers 1,000 bonds to fund-b against 101,200.00 tEUR.
    await (await dvpAt(dvpAddr, fundA).createInstruction(fundA.address, fundB.address, token("ACME-2030"), 1_000, token("tEUR"), 101_200_00, (await now()) + 86_400)).wait();
    await (await dvpAt(dvpAddr, fundB).affirm(1)).wait();
    await (await tokenAt(token("ACME-2030"), fundA).approve(dvpAddr, 1_000)).wait();
    await (await tokenAt(token("tEUR"), fundB).approve(dvpAddr, 101_200_00)).wait();
    await (await dvpAt(dvpAddr, issuer).settle(1)).wait();
    console.log("  #1 fund-a -> fund-b  1,000 ACME-2030 vs 101,200.00 tEUR   SETTLED");

    // #2 fails: bank-c holds only 250,000.00 tEUR but owes 253,000.00.
    await (await dvpAt(dvpAddr, fundA).createInstruction(fundA.address, bankC.address, token("ACME-2030"), 2_500, token("tEUR"), 253_000_00, (await now()) + 86_400)).wait();
    await (await dvpAt(dvpAddr, bankC).affirm(2)).wait();
    await (await tokenAt(token("ACME-2030"), fundA).approve(dvpAddr, 2_500)).wait();
    await (await tokenAt(token("tEUR"), bankC).approve(dvpAddr, 253_000_00)).wait();
    await (await dvpAt(dvpAddr, issuer).settle(2)).wait();
    console.log("  #2 fund-a -> bank-c  2,500 ACME-2030 vs 253,000.00 tEUR   FAILED (buyer short cash)");

    // #3 pending: bank-c sells fund units, fund-a has not affirmed, deadline in 30 minutes.
    await (await dvpAt(dvpAddr, bankC).createInstruction(bankC.address, fundA.address, token("NWGF"), 50, token("tEUR"), 6_250_00, (await now()) + 30 * 60)).wait();
    console.log("  #3 bank-c -> fund-a  50 NWGF vs 6,250.00 tEUR             PENDING (awaiting fund-a, 30 min left)");

    step("7. Pre-trade compliance check");
    const code = Number(await tokenAt(token("NWGF"), ethers.provider).canTransfer(bankC.address, unverified.address, 10));
    console.log(`  bank-c -> unverified wallet, 10 NWGF: ${COMPLIANCE_CODES[code]}`);

    step("8. Detokenize 500 ACME-2030 held by fund-b back to the register");
    await ops.detokenize("ACME-2030", "fund-b", 500n);

    step("9. Index chain events into the ledger");
    const sync = await indexer.sync();
    console.log(`  blocks ${sync.fromBlock}-${sync.toBlock}, ${sync.eventsProcessed} events`);
    printPositions(ledger);

    step("10. Reconcile ledger against chain");
    printRecon(await reconcile(ledger, ethers.provider));

    step("11. Timing break: on-chain transfer the ledger has not indexed yet");
    await (await tokenAt(token("ACME-2030"), fundB).transfer(bankC.address, 200)).wait();
    console.log("  fund-b transfers 200 ACME-2030 to bank-c directly on-chain");
    printRecon(await reconcile(ledger, ethers.provider));
    await indexer.sync();
    console.log("  after sync:");
    printRecon(await reconcile(ledger, ethers.provider));

    step("12. Settlement risk on pending instructions");
    const risk = await assessSettlementRisk(ledger, ethers.provider, dvpAddr);
    for (const r of risk.instructions) {
        console.log(`  #${r.instructionId} ${r.riskLevel.padEnd(6)} would fail with: ${r.wouldFailWith ?? "-"}  (${r.minutesToDeadline} min to deadline)`);
        for (const issue of r.issues) console.log(`      issue:  ${issue}`);
        for (const action of r.suggestedActions) console.log(`      action: ${action}`);
    }

    ledger.close();
    console.log("\nDeployment written to deployments/localhost.json, ledger to data/ledger.db.");
    console.log("Next: `npm run mcp:smoke`, or open this folder in VS Code and ask Copilot (agent mode) about fund-a's positions.");
}

function printPositions(ledger: PositionLedger) {
    const rows = ledger
        .positions()
        .filter((p) => ledger.getAccount(p.accountId)?.kind === "CLIENT")
        .map((p) => {
            const d = ledger.getInstrument(p.instrumentId)!.decimals;
            return {
                account: p.accountId,
                instrument: p.instrumentId,
                onchain: formatQty(p.onchain, d),
                book: formatQty(p.book, d),
                total: formatQty(p.onchain + p.book, d),
            };
        });
    console.table(rows);
}

function printRecon(r: Awaited<ReturnType<typeof reconcile>>) {
    console.log(`  ${r.status}: ${r.positionsChecked} positions checked, ledger@${r.ledgerSyncedToBlock}, chain@${r.chainHeadBlock}`);
    for (const b of r.breaks) {
        console.log(`    ${b.kind} ${b.instrumentId} ${b.accountId ?? ""} ledger=${b.ledger} chain=${b.chain} diff=${b.difference}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
