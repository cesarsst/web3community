import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ZeroHash } from "ethers";

/**
 * CommunityTimelock test suite.
 *
 * Cobre o wrapper direto do {TimelockController} da OZ. Como o wrapper e
 * puramente identitario (nenhum codigo adicional), os testes focam em:
 *  - Construcao (role grants para proposer/executor/admin e minDelay).
 *  - Papeis (PROPOSER_ROLE, EXECUTOR_ROLE, CANCELLER_ROLE, DEFAULT_ADMIN_ROLE).
 *  - Ciclo schedule -> delay -> execute; execucao antes do delay reverte.
 *  - Cancel por CANCELLER_ROLE.
 *  - Self-administration: apos renuncia do admin, roles so sao alteraveis via
 *    execucao agendada pelo Timelock de si mesmo.
 *  - Suporte a interfaces (IAccessControl, IERC721Receiver, IERC1155Receiver).
 *
 * Mapeia invariantes:
 *  - I4: admin renuncia -> Timelock e self-administered -> unico portador
 *    viavel de GOVERNANCE_ROLE em producao.
 *  - I7: schedule + delay antes de qualquer acao state-changing via Timelock.
 */
describe("CommunityTimelock", function () {
  const MIN_DELAY = 3600n; // 1h — valor dev/teste

  async function deployFixture() {
    const [admin, proposer, executor, canceller, other, target] = await ethers.getSigners();

    const Timelock = await ethers.getContractFactory("CommunityTimelock");
    const timelock = await Timelock.deploy(
      MIN_DELAY,
      [proposer.address],
      [executor.address],
      admin.address,
    );
    await timelock.waitForDeployment();

    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
    const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
    const DEFAULT_ADMIN_ROLE = await timelock.DEFAULT_ADMIN_ROLE();

    // Mint de target (ERC20Mock) para permitir operations simples como transfer.
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    const token = await ERC20Mock.deploy("Mock", "MOCK");
    await token.waitForDeployment();
    await token.mint(await timelock.getAddress(), 1_000_000n);

    return {
      timelock,
      token,
      admin,
      proposer,
      executor,
      canceller,
      other,
      target,
      PROPOSER_ROLE,
      EXECUTOR_ROLE,
      CANCELLER_ROLE,
      DEFAULT_ADMIN_ROLE,
    };
  }

  describe("construction", function () {
    it("grants expected roles on deploy", async function () {
      const {
        timelock,
        admin,
        proposer,
        executor,
        PROPOSER_ROLE,
        EXECUTOR_ROLE,
        CANCELLER_ROLE,
        DEFAULT_ADMIN_ROLE,
      } = await loadFixture(deployFixture);

      expect(await timelock.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await timelock.hasRole(PROPOSER_ROLE, proposer.address)).to.equal(true);
      // OZ 5.0.x auto-concede CANCELLER_ROLE a todos os proposers iniciais.
      expect(await timelock.hasRole(CANCELLER_ROLE, proposer.address)).to.equal(true);
      expect(await timelock.hasRole(EXECUTOR_ROLE, executor.address)).to.equal(true);
    });

    it("exposes the minDelay passed in the constructor", async function () {
      const { timelock } = await loadFixture(deployFixture);
      expect(await timelock.getMinDelay()).to.equal(MIN_DELAY);
    });

    it("self-administered: timelock has DEFAULT_ADMIN_ROLE on itself", async function () {
      const { timelock, DEFAULT_ADMIN_ROLE } = await loadFixture(deployFixture);
      const timelockAddr = await timelock.getAddress();
      expect(await timelock.hasRole(DEFAULT_ADMIN_ROLE, timelockAddr)).to.equal(true);
    });

    it("supports IAccessControl and ERC1155Receiver interfaces", async function () {
      const { timelock } = await loadFixture(deployFixture);
      // IAccessControl
      expect(await timelock.supportsInterface("0x7965db0b")).to.equal(true);
      // ERC165 selector
      expect(await timelock.supportsInterface("0x01ffc9a7")).to.equal(true);
      // IERC1155Receiver (0x4e2312e0)
      expect(await timelock.supportsInterface("0x4e2312e0")).to.equal(true);
      expect(await timelock.supportsInterface("0xffffffff")).to.equal(false);
    });
  });

  describe("schedule -> execute lifecycle", function () {
    // Helper: prepara uma operacao de transfer(token, other, 100)
    async function prepOp(
      fixture: Awaited<ReturnType<typeof deployFixture>>,
      amount: bigint = 100n,
      salt: string = ZeroHash,
    ) {
      const { token, other } = fixture;
      const tokenAddr = await token.getAddress();
      const iface = token.interface;
      const data = iface.encodeFunctionData("transfer", [other.address, amount]);
      return {
        target: tokenAddr,
        value: 0n,
        data,
        predecessor: ZeroHash,
        salt,
      };
    }

    it("schedules and executes after delay", async function () {
      const fixture = await loadFixture(deployFixture);
      const { timelock, proposer, executor, token, other } = fixture;
      const op = await prepOp(fixture);

      await expect(
        timelock
          .connect(proposer)
          .schedule(op.target, op.value, op.data, op.predecessor, op.salt, MIN_DELAY),
      ).to.emit(timelock, "CallScheduled");

      // Executar antes do delay deve reverter.
      await expect(
        timelock.connect(executor).execute(op.target, op.value, op.data, op.predecessor, op.salt),
      ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

      // Avanca tempo e executa.
      await time.increase(MIN_DELAY);
      await expect(
        timelock.connect(executor).execute(op.target, op.value, op.data, op.predecessor, op.salt),
      ).to.emit(timelock, "CallExecuted");

      expect(await token.balanceOf(other.address)).to.equal(100n);
    });

    it("reverts schedule for non-proposer", async function () {
      const fixture = await loadFixture(deployFixture);
      const { timelock, other, PROPOSER_ROLE } = fixture;
      const op = await prepOp(fixture);
      await expect(
        timelock
          .connect(other)
          .schedule(op.target, op.value, op.data, op.predecessor, op.salt, MIN_DELAY),
      )
        .to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, PROPOSER_ROLE);
    });

    it("reverts schedule with delay < minDelay", async function () {
      const fixture = await loadFixture(deployFixture);
      const { timelock, proposer } = fixture;
      const op = await prepOp(fixture);
      await expect(
        timelock
          .connect(proposer)
          .schedule(op.target, op.value, op.data, op.predecessor, op.salt, MIN_DELAY - 1n),
      ).to.be.revertedWithCustomError(timelock, "TimelockInsufficientDelay");
    });

    it("reverts execute for non-executor", async function () {
      const fixture = await loadFixture(deployFixture);
      const { timelock, proposer, other, EXECUTOR_ROLE } = fixture;
      const op = await prepOp(fixture);
      await timelock
        .connect(proposer)
        .schedule(op.target, op.value, op.data, op.predecessor, op.salt, MIN_DELAY);
      await time.increase(MIN_DELAY);
      await expect(
        timelock.connect(other).execute(op.target, op.value, op.data, op.predecessor, op.salt),
      )
        .to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, EXECUTOR_ROLE);
    });
  });

  describe("cancel", function () {
    it("canceller cancels pending op", async function () {
      const fixture = await loadFixture(deployFixture);
      const { timelock, proposer } = fixture;
      const tokenAddr = await fixture.token.getAddress();
      const data = fixture.token.interface.encodeFunctionData("transfer", [
        fixture.other.address,
        1n,
      ]);
      const id = await timelock.hashOperation(tokenAddr, 0n, data, ZeroHash, ZeroHash);

      await timelock.connect(proposer).schedule(tokenAddr, 0n, data, ZeroHash, ZeroHash, MIN_DELAY);

      // `proposer` tambem tem CANCELLER_ROLE por padrao OZ.
      await expect(timelock.connect(proposer).cancel(id))
        .to.emit(timelock, "Cancelled")
        .withArgs(id);
    });

    it("reverts cancel for non-canceller", async function () {
      const fixture = await loadFixture(deployFixture);
      const { timelock, proposer, other, CANCELLER_ROLE } = fixture;
      const tokenAddr = await fixture.token.getAddress();
      const data = fixture.token.interface.encodeFunctionData("transfer", [
        fixture.other.address,
        1n,
      ]);
      const id = await timelock.hashOperation(tokenAddr, 0n, data, ZeroHash, ZeroHash);

      await timelock.connect(proposer).schedule(tokenAddr, 0n, data, ZeroHash, ZeroHash, MIN_DELAY);

      await expect(timelock.connect(other).cancel(id))
        .to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, CANCELLER_ROLE);
    });
  });

  describe("self-administration flow", function () {
    it("admin can renounce and timelock remains self-administered", async function () {
      const { timelock, admin, DEFAULT_ADMIN_ROLE } = await loadFixture(deployFixture);
      await timelock.connect(admin).renounceRole(DEFAULT_ADMIN_ROLE, admin.address);
      expect(await timelock.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(false);
      // Timelock continua auto-administrado.
      const timelockAddr = await timelock.getAddress();
      expect(await timelock.hasRole(DEFAULT_ADMIN_ROLE, timelockAddr)).to.equal(true);
    });

    it("updateDelay only callable via self-execution (onlyTimelock)", async function () {
      const { timelock, admin } = await loadFixture(deployFixture);
      // Chamada externa direta reverte mesmo vindo do admin.
      await expect(timelock.connect(admin).updateDelay(7200n)).to.be.revertedWithCustomError(
        timelock,
        "TimelockUnauthorizedCaller",
      );
    });
  });
});
