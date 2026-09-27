import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JsonRpcProvider } from "ethers";
import { z } from "zod";
import { COMPLIANCE_CODES, tokenAt } from "../chain/contracts";
import { DEFAULT_DB_PATH, DEFAULT_DEPLOYMENT_PATH, loadDeployment } from "../config";
import { formatQty, parseQty } from "../format";
import { ChainIndexer } from "../indexer";
import { PositionLedger, type Account, type SettlementInstruction } from "../ledger/ledger";
import { reconcile } from "../reconciliation";
import { assessSettlementRisk } from "../settlementRisk";

const config = loadDeployment(process.env.TPK_DEPLOYMENT ?? DEFAULT_DEPLOYMENT_PATH);
const ledger = new PositionLedger(process.env.TPK_DB ?? DEFAULT_DB_PATH);
ledger.initialize(config);
const provider = new JsonRpcProvider(process.env.TPK_RPC_URL ?? "http://127.0.0.1:8545", config.chainId, {
    staticNetwork: true,
});
const indexer = new ChainIndexer(ledger, provider, config);

// Least privilege: the agent sees only the accounts it was provisioned for.
const scopeSetting = process.env.TPK_ALLOWED_ACCOUNTS?.trim();
if (!scopeSetting) {
    console.error('TPK_ALLOWED_ACCOUNTS is required, e.g. "fund-a,fund-b" or "*" for all client accounts.');
    process.exit(1);
}
const clientAccounts = () => ledger.listAccounts("CLIENT");
const scope = (): string[] =>
    scopeSetting === "*" ? clientAccounts().map((a) => a.id) : scopeSetting.split(",").map((s) => s.trim());

class AccessDenied extends Error { }

function requireAccess(accountId: string): Account {
    const account = ledger.getAccount(accountId);
    if (!account || !scope().includes(accountId)) {
        throw new AccessDenied(`Access denied: account "${accountId}" is not in this agent's scope.`);
    }
    return account;
}

/** Brings the ledger up to the chain head so every answer reflects real-time state. */
async function fresh() {
    await indexer.sync();
    const block = await provider.getBlock(indexer.lastIndexedBlock);
    return { asOfBlock: indexer.lastIndexedBlock, asOfTime: new Date(Number(block!.timestamp) * 1000).toISOString() };
}

const decimalsOf = (instrumentId: string) => ledger.getInstrument(instrumentId)?.decimals ?? 0;

function describeInstruction(i: SettlementInstruction) {
    return {
        instructionId: i.id,
        status: i.status,
        seller: i.sellerAccount,
        buyer: i.buyerAccount,
        asset: { instrumentId: i.assetInstrument, quantity: formatQty(i.assetQuantity, decimalsOf(i.assetInstrument)) },
        cash: { instrumentId: i.cashInstrument, quantity: formatQty(i.cashQuantity, decimalsOf(i.cashInstrument)) },
        deadline: new Date(i.deadline * 1000).toISOString(),
        sellerAffirmed: i.sellerAffirmed,
        buyerAffirmed: i.buyerAffirmed,
        failedAttempts: i.failedAttempts,
        lastFailureReason: i.lastFailureReason,
    };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function handler<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
    return async (args) => {
        try {
            return { content: [{ type: "text", text: JSON.stringify(await fn(args), null, 2) }] };
        } catch (err) {
            const message = err instanceof AccessDenied ? err.message : `Error: ${(err as Error).message}`;
            if (!(err instanceof AccessDenied)) console.error(err);
            return { content: [{ type: "text", text: message }], isError: true };
        }
    };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const server = new McpServer(
    { name: "tokenized-wallet", version: "0.1.0" },
    {
        instructions:
            "Read-only wallet service over a hybrid on-chain/book-entry position ledger. Quantities are decimal strings " +
            "in instrument units. Every response carries asOfBlock/asOfTime. Positions have an ONCHAIN (tokenized) and a " +
            "BOOK (book-entry register) component. This server cannot move assets.",
    },
);

server.registerTool(
    "list_accounts",
    { title: "List accounts", description: "Accounts this agent is allowed to query, with their wallet addresses.", annotations: readOnly },
    handler(async () => ({
        accounts: clientAccounts()
            .filter((a) => scope().includes(a.id))
            .map((a) => ({ accountId: a.id, name: a.name, wallet: a.wallet })),
    })),
);

server.registerTool(
    "list_instruments",
    {
        title: "List instruments",
        description: "All instruments with form TOKENIZED (on-chain only), BOOK_ENTRY (register only) or HYBRID (both).",
        annotations: readOnly,
    },
    handler(async () => ({ instruments: ledger.listInstruments() })),
);

server.registerTool(
    "get_positions",
    {
        title: "Get positions",
        description: "Real-time positions of one account, split into on-chain and book-entry holdings.",
        inputSchema: { account_id: z.string().describe("Account id, e.g. fund-a") },
        annotations: readOnly,
    },
    handler(async ({ account_id }: { account_id: string }) => {
        const account = requireAccess(account_id);
        const asOf = await fresh();
        return {
            ...asOf,
            account: { accountId: account.id, name: account.name, wallet: account.wallet },
            positions: ledger.positions(account.id).map((p) => {
                const instrument = ledger.getInstrument(p.instrumentId)!;
                const fmt = (q: bigint) => formatQty(q, instrument.decimals);
                return {
                    instrumentId: instrument.id,
                    name: instrument.name,
                    form: instrument.form,
                    onchain: fmt(p.onchain),
                    book: fmt(p.book),
                    total: fmt(p.onchain + p.book),
                };
            }),
        };
    }),
);

server.registerTool(
    "get_position_history",
    {
        title: "Get position history",
        description: "Most recent ledger movements for an account, newest first, with entry type and transaction hash.",
        inputSchema: {
            account_id: z.string(),
            instrument_id: z.string().optional(),
            limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
        },
        annotations: readOnly,
    },
    handler(async ({ account_id, instrument_id, limit }: { account_id: string; instrument_id?: string; limit?: number }) => {
        requireAccess(account_id);
        const asOf = await fresh();
        return {
            ...asOf,
            movements: ledger.history(account_id, instrument_id, limit ?? 20).map((m) => ({
                ...m,
                quantity: formatQty(m.quantity, decimalsOf(m.instrumentId)),
            })),
        };
    }),
);

server.registerTool(
    "list_settlement_instructions",
    {
        title: "List settlement instructions",
        description: "DvP settlement instructions where an in-scope account is buyer or seller.",
        inputSchema: {
            account_id: z.string().optional(),
            status: z.enum(["PENDING", "SETTLED", "CANCELLED", "EXPIRED"]).optional(),
        },
        annotations: readOnly,
    },
    handler(async ({ account_id, status }: { account_id?: string; status?: "PENDING" | "SETTLED" | "CANCELLED" | "EXPIRED" }) => {
        if (account_id) requireAccess(account_id);
        const asOf = await fresh();
        return {
            ...asOf,
            instructions: ledger.listInstructions({ accountIds: account_id ? [account_id] : scope(), status }).map(describeInstruction),
        };
    }),
);

server.registerTool(
    "assess_settlement_risk",
    {
        title: "Assess settlement risk",
        description:
            "Dry-runs every pending DvP instruction on-chain and explains which will fail, why, how large the shortfall is, and what would fix it.",
        inputSchema: { account_id: z.string().optional() },
        annotations: readOnly,
    },
    handler(async ({ account_id }: { account_id?: string }) => {
        if (account_id) requireAccess(account_id);
        await fresh();
        return assessSettlementRisk(ledger, provider, config.contracts.dvp, { accountIds: account_id ? [account_id] : scope() });
    }),
);

server.registerTool(
    "reconcile_positions",
    {
        title: "Reconcile positions",
        description:
            "Compares ledger positions with on-chain balances. Distinguishes TIMING breaks (not yet indexed) from genuine mismatches, and checks supply and 1:1 backing of hybrid instruments.",
        inputSchema: { sync_first: z.boolean().optional().describe("Index new blocks before reconciling. Default true.") },
        annotations: readOnly,
    },
    handler(async ({ sync_first }: { sync_first?: boolean }) => {
        if (sync_first !== false) await indexer.sync();
        return reconcile(ledger, provider, { accountIds: scope() });
    }),
);

server.registerTool(
    "check_transfer_compliance",
    {
        title: "Check transfer compliance",
        description: "Pre-trade check: would the token contract allow this transfer right now? Does not execute anything.",
        inputSchema: {
            from_account_id: z.string(),
            to_account_id: z.string(),
            instrument_id: z.string(),
            quantity: z.string().describe('Decimal quantity in instrument units, e.g. "100" or "2500.50"'),
        },
        annotations: readOnly,
    },
    handler(
        async (args: { from_account_id: string; to_account_id: string; instrument_id: string; quantity: string }) => {
            const from = requireAccess(args.from_account_id);
            const to = ledger.getAccount(args.to_account_id);
            if (!to?.wallet) throw new Error(`Unknown counterparty account "${args.to_account_id}"`);
            const instrument = ledger.getInstrument(args.instrument_id);
            if (!instrument?.tokenAddress) throw new Error(`"${args.instrument_id}" is not an on-chain instrument`);
            const quantity = parseQty(args.quantity, instrument.decimals);
            const code = Number(await tokenAt(instrument.tokenAddress, provider).canTransfer(from.wallet, to.wallet, quantity));
            return { allowed: code === 0, code, reason: COMPLIANCE_CODES[code] ?? `UNKNOWN_${code}` };
        },
    ),
);

async function main() {
    await server.connect(new StdioServerTransport());
    console.error(`tokenized-wallet MCP server ready (scope: ${scope().join(", ")})`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
