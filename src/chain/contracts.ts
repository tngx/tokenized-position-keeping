import fs from "node:fs";
import path from "node:path";
import { Contract, type ContractRunner, type InterfaceAbi } from "ethers";
import { PROJECT_ROOT } from "../paths";

export type ContractName = "IdentityRegistry" | "SecurityToken" | "DvPSettlement";

interface Artifact {
  abi: InterfaceAbi;
  bytecode: string;
}

const cache = new Map<ContractName, Artifact>();

export function loadArtifact(name: ContractName): Artifact {
  let artifact = cache.get(name);
  if (!artifact) {
    const file = path.join(PROJECT_ROOT, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
    if (!fs.existsSync(file)) throw new Error(`Missing artifact ${file}. Run "npm run compile".`);
    artifact = JSON.parse(fs.readFileSync(file, "utf8")) as Artifact;
    cache.set(name, artifact);
  }
  return artifact;
}

export const tokenAt = (address: string, runner: ContractRunner) =>
  new Contract(address, loadArtifact("SecurityToken").abi, runner);

export const dvpAt = (address: string, runner: ContractRunner) =>
  new Contract(address, loadArtifact("DvPSettlement").abi, runner);

export const registryAt = (address: string, runner: ContractRunner) =>
  new Contract(address, loadArtifact("IdentityRegistry").abi, runner);

export const COMPLIANCE_CODES: Record<number, string> = {
  0: "OK",
  1: "PAUSED",
  2: "SENDER_NOT_VERIFIED",
  3: "RECIPIENT_NOT_VERIFIED",
  4: "SENDER_FROZEN",
  5: "RECIPIENT_FROZEN",
  6: "INSUFFICIENT_BALANCE",
};

export const SETTLEMENT_FAILURE_REASONS: Record<number, string> = {
  0: "NONE",
  1: "NOT_AFFIRMED",
  2: "SELLER_INSUFFICIENT_ASSET",
  3: "ASSET_NOT_COMPLIANT",
  4: "ASSET_ALLOWANCE_MISSING",
  5: "BUYER_INSUFFICIENT_CASH",
  6: "CASH_NOT_COMPLIANT",
  7: "CASH_ALLOWANCE_MISSING",
};
