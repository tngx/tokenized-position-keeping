import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PROJECT_ROOT } from "../src/paths";

// Drives the MCP server the way an AI agent would, including a call outside its scope.
async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "--disable-warning=ExperimentalWarning", "src/mcp/server.ts"],
    cwd: PROJECT_ROOT,
    env: { ...(process.env as Record<string, string>), TPK_ALLOWED_ACCOUNTS: "fund-a,fund-b" },
    stderr: "inherit",
  });
  const client = new Client({ name: "smoke-test", version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log("Tools:", tools.map((t) => t.name).join(", "));

  const calls: [string, Record<string, unknown>][] = [
    ["list_accounts", {}],
    ["get_positions", { account_id: "fund-a" }],
    ["get_positions", { account_id: "bank-c" }],
    ["assess_settlement_risk", { account_id: "fund-a" }],
    ["reconcile_positions", {}],
    ["check_transfer_compliance", { from_account_id: "fund-a", to_account_id: "fund-b", instrument_id: "ACME-2030", quantity: "100" }],
  ];
  for (const [name, args] of calls) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0].text;
    console.log(`\n--- ${name}(${JSON.stringify(args)})${result.isError ? "  [isError]" : ""}\n${text}`);
  }
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
