import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const REF = ethers.id("test-ref");

async function deployFixture() {
  const [issuer, seller, buyer, outsider] = await ethers.getSigners();

  const registry = await ethers.deployContract("IdentityRegistry", [issuer.address]);
  const bond = await ethers.deployContract("SecurityToken", [
    "Demo Bond 2030", "DB30", 0, "DE000DEMO001", "BOND", await registry.getAddress(), issuer.address,
  ]);
  const cash = await ethers.deployContract("SecurityToken", [
    "Tokenized EUR Deposit", "tEUR", 2, "", "CASH", await registry.getAddress(), issuer.address,
  ]);
  const dvp = await ethers.deployContract("DvPSettlement");

  await registry.registerInvestor(seller.address, 276);
  await registry.registerInvestor(buyer.address, 276);

  await bond.tokenize(seller.address, 1_000, REF);
  await cash.tokenize(buyer.address, 100_000_00, REF);

  return { issuer, seller, buyer, outsider, registry, bond, cash, dvp };
}

describe("SecurityToken", () => {
  it("blocks transfers to wallets that are not KYC-verified", async () => {
    const { seller, outsider, bond } = await loadFixture(deployFixture);
    await expect(bond.connect(seller).transfer(outsider.address, 1))
      .to.be.revertedWithCustomError(bond, "TransferNotCompliant")
      .withArgs(3);
    expect(await bond.canTransfer(seller.address, outsider.address, 1)).to.equal(3);
  });

  it("lets the agent freeze a wallet and pause the instrument", async () => {
    const { seller, buyer, bond } = await loadFixture(deployFixture);
    await bond.setFrozen(seller.address, true);
    await expect(bond.connect(seller).transfer(buyer.address, 1))
      .to.be.revertedWithCustomError(bond, "TransferNotCompliant")
      .withArgs(4);

    await bond.setFrozen(seller.address, false);
    await bond.pause();
    expect(await bond.canTransfer(seller.address, buyer.address, 1)).to.equal(1);
  });

  it("restricts tokenize and detokenize to the issuer and emits linkage references", async () => {
    const { seller, bond } = await loadFixture(deployFixture);
    await expect(bond.connect(seller).tokenize(seller.address, 1, REF)).to.be.revertedWithCustomError(
      bond, "AccessControlUnauthorizedAccount",
    );
    await expect(bond.detokenize(seller.address, 400, REF))
      .to.emit(bond, "Detokenized")
      .withArgs(seller.address, 400, REF);
    expect(await bond.totalSupply()).to.equal(600);
  });
});

describe("DvPSettlement", () => {
  async function instruct(fx: Awaited<ReturnType<typeof deployFixture>>, assetAmount: bigint, cashAmount: bigint) {
    const deadline = (await time.latest()) + 3_600;
    await fx.dvp.connect(fx.seller).createInstruction(
      fx.seller.address, fx.buyer.address,
      await fx.bond.getAddress(), assetAmount,
      await fx.cash.getAddress(), cashAmount,
      deadline,
    );
    return 1n;
  }

  it("settles both legs atomically", async () => {
    const fx = await loadFixture(deployFixture);
    const id = await instruct(fx, 100n, 10_120_00n);
    await fx.dvp.connect(fx.buyer).affirm(id);
    await fx.bond.connect(fx.seller).approve(await fx.dvp.getAddress(), 100);
    await fx.cash.connect(fx.buyer).approve(await fx.dvp.getAddress(), 10_120_00);

    const tx = fx.dvp.settle(id);
    await expect(tx).to.emit(fx.dvp, "Settled").withArgs(id);
    await expect(tx).to.changeTokenBalances(fx.bond, [fx.seller, fx.buyer], [-100, 100]);
    await expect(tx).to.changeTokenBalances(fx.cash, [fx.buyer, fx.seller], [-10_120_00, 10_120_00]);
  });

  it("records a settlement fail with a reason code and moves nothing", async () => {
    const fx = await loadFixture(deployFixture);
    const id = await instruct(fx, 100n, 200_000_00n);
    await fx.dvp.connect(fx.buyer).affirm(id);
    await fx.bond.connect(fx.seller).approve(await fx.dvp.getAddress(), 100);
    await fx.cash.connect(fx.buyer).approve(await fx.dvp.getAddress(), 200_000_00);

    const tx = fx.dvp.settle(id);
    await expect(tx).to.emit(fx.dvp, "SettlementFailed").withArgs(id, 5);
    await expect(tx).to.changeTokenBalances(fx.bond, [fx.seller, fx.buyer], [0, 0]);
    expect((await fx.dvp.instructions(id)).failedAttempts).to.equal(1);
  });

  it("reports missing affirmation and allowance before settlement", async () => {
    const fx = await loadFixture(deployFixture);
    const id = await instruct(fx, 100n, 10_000_00n);
    expect(await fx.dvp.checkSettlement(id)).to.equal(1);
    await fx.dvp.connect(fx.buyer).affirm(id);
    expect(await fx.dvp.checkSettlement(id)).to.equal(4);
  });

  it("expires instructions past their deadline", async () => {
    const fx = await loadFixture(deployFixture);
    const id = await instruct(fx, 100n, 10_000_00n);
    await time.increase(7_200);
    await expect(fx.dvp.settle(id)).to.emit(fx.dvp, "Expired").withArgs(id);
    expect((await fx.dvp.instructions(id)).status).to.equal(4);
  });

  it("only lets parties create, affirm or cancel", async () => {
    const fx = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 3_600;
    await expect(
      fx.dvp.connect(fx.outsider).createInstruction(
        fx.seller.address, fx.buyer.address, await fx.bond.getAddress(), 1, await fx.cash.getAddress(), 1, deadline,
      ),
    ).to.be.revertedWithCustomError(fx.dvp, "NotAParty");
    const id = await instruct(fx, 1n, 1n);
    await expect(fx.dvp.connect(fx.outsider).affirm(id)).to.be.revertedWithCustomError(fx.dvp, "NotAParty");
    await fx.dvp.connect(fx.buyer).affirm(id);
    await expect(fx.dvp.connect(fx.seller).cancel(id)).to.be.revertedWithCustomError(fx.dvp, "AlreadyFullyAffirmed");
  });
});
