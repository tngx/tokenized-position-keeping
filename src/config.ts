import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./paths";

/** TOKENIZED: exists only on-chain. BOOK_ENTRY: exists only in the register. HYBRID: both, bridged via a token vault. */
export type InstrumentForm = "TOKENIZED" | "BOOK_ENTRY" | "HYBRID";

export interface InstrumentConfig {
  id: string;
  symbol: string;
  name: string;
  isin?: string;
  assetClass: string;
  form: InstrumentForm;
  decimals: number;
  tokenAddress?: string;
}

export interface AccountConfig {
  id: string;
  name: string;
  wallet?: string;
}

export interface DeploymentConfig {
  network: string;
  chainId: number;
  deployBlock: number;
  contracts: { identityRegistry: string; dvp: string };
  instruments: InstrumentConfig[];
  accounts: AccountConfig[];
}

export const DEFAULT_DEPLOYMENT_PATH = path.join(PROJECT_ROOT, "deployments", "localhost.json");
export const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "data", "ledger.db");

export function loadDeployment(file = DEFAULT_DEPLOYMENT_PATH): DeploymentConfig {
  if (!fs.existsSync(file)) {
    throw new Error(`Deployment file not found: ${file}. Start the chain and run "npm run demo" first.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as DeploymentConfig;
}

export function saveDeployment(config: DeploymentConfig, file = DEFAULT_DEPLOYMENT_PATH): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}
