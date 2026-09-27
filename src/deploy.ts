import { ContractFactory, type BaseContract, type Signer } from "ethers";
import { loadArtifact, type ContractName } from "./chain/contracts";
import type { AccountConfig, DeploymentConfig, InstrumentConfig } from "./config";

export type InstrumentSpec = Omit<InstrumentConfig, "tokenAddress">;

async function deploy(name: ContractName, deployer: Signer, ...args: unknown[]): Promise<{ address: string; block: number }> {
    const { abi, bytecode } = loadArtifact(name);
    const contract: BaseContract = await new ContractFactory(abi, bytecode, deployer).deploy(...args);
    const receipt = await contract.deploymentTransaction()!.wait();
    return { address: await contract.getAddress(), block: receipt!.blockNumber };
}

/** Deploys the identity registry, DvP contract and one SecurityToken per TOKENIZED or HYBRID instrument. */
export async function deployPlatform(
    deployer: Signer,
    instruments: InstrumentSpec[],
    accounts: AccountConfig[],
    network = "localhost",
): Promise<DeploymentConfig> {
    const admin = await deployer.getAddress();
    const registry = await deploy("IdentityRegistry", deployer, admin);
    const dvp = await deploy("DvPSettlement", deployer);

    const deployed: InstrumentConfig[] = [];
    for (const spec of instruments) {
        if (spec.form === "BOOK_ENTRY") {
            deployed.push(spec);
            continue;
        }
        const token = await deploy(
            "SecurityToken", deployer,
            spec.name, spec.symbol, spec.decimals, spec.isin ?? "", spec.assetClass, registry.address, admin,
        );
        deployed.push({ ...spec, tokenAddress: token.address });
    }

    const { chainId } = await deployer.provider!.getNetwork();
    return {
        network,
        chainId: Number(chainId),
        deployBlock: registry.block,
        contracts: { identityRegistry: registry.address, dvp: dvp.address },
        instruments: deployed,
        accounts,
    };
}
