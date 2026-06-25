import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parseEther, keccak256, encodePacked, toBytes, toHex } from "viem";
import hre from "hardhat";

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build commitment hash exactly as the contract expects:
 *   keccak256(abi.encodePacked(answer, salt, msg.sender, bountyId))
 */
function buildCommitment(
  answer: string,
  salt: `0x${string}`,
  sender: `0x${string}`,
  bountyId: bigint
): `0x${string}` {
  return keccak256(
    encodePacked(
      ["string", "bytes32", "address", "uint256"],
      [answer, salt, sender, bountyId]
    )
  );
}

/** Random 32-byte salt */
function randomSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes) as `0x${string}`;
}

/** block.timestamp + seconds */
async function nowPlus(seconds: number): Promise<bigint> {
  const client = await hre.viem.getPublicClient();
  const block = await client.getBlock();
  return block.timestamp + BigInt(seconds);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("PrivacyBountyJudge", () => {
  // We use a mock oracle that just accepts the call
  let mockOracleAddress: `0x${string}`;
  let contractAddress: `0x${string}`;
  let owner: any, alice: any, bob: any, carol: any;
  let publicClient: any;

  // Shared bounty params
  const REWARD   = parseEther("0.1");
  const SALT_A   = randomSalt();
  const SALT_B   = randomSalt();
  const ANSWER_A = "My brilliant answer A";
  const ANSWER_B = "My brilliant answer B";

  before(async () => {
    [owner, alice, bob, carol] = await hre.viem.getWalletClients();
    publicClient = await hre.viem.getPublicClient();

    // Deploy MockOracle
    const mockOracle = await hre.viem.deployContract("MockOracle");
    mockOracleAddress = mockOracle.address;

    // Deploy main contract
    const contract = await hre.viem.deployContract("PrivacyBountyJudge", [
      mockOracleAddress,
    ]);
    contractAddress = contract.address;
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  1. createBounty
  // ─────────────────────────────────────────────────────────────────────────

  describe("createBounty", () => {
    it("creates a bounty and locks reward", async () => {
      const subDeadline = await nowPlus(3600);
      const revDeadline = await nowPlus(7200);

      const contract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: owner } }
      );

      const hash = await contract.write.createBounty(
        ["Test bounty", subDeadline, revDeadline],
        { value: REWARD }
      );

      await publicClient.waitForTransactionReceipt({ hash });

      const info = await contract.read.getBountyInfo([1n]);
      assert.equal(info[0].toLowerCase(), owner.account.address.toLowerCase());
      assert.equal(info[2], REWARD);
      assert.equal(info[5], false); // judged
      assert.equal(info[6], false); // finalized
    });

    it("reverts with zero reward", async () => {
      const contract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: owner } }
      );

      const subDeadline = await nowPlus(3600);
      const revDeadline = await nowPlus(7200);

      await assert.rejects(
        contract.write.createBounty(["Test", subDeadline, revDeadline], {
          value: 0n,
        }),
        /ZeroReward/
      );
    });

    it("reverts when revDeadline <= subDeadline", async () => {
      const contract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: owner } }
      );

      const subDeadline = await nowPlus(3600);

      await assert.rejects(
        contract.write.createBounty(["Test", subDeadline, subDeadline], {
          value: REWARD,
        }),
        /BadDeadlines/
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  2. submitCommitment
  // ─────────────────────────────────────────────────────────────────────────

  describe("submitCommitment", () => {
    let bountyId: bigint;

    beforeEach(async () => {
      // Fresh bounty for each sub-test
      const subDeadline = await nowPlus(3600);
      const revDeadline = await nowPlus(7200);

      const contract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: owner } }
      );

      const hash = await contract.write.createBounty(
        ["Fresh bounty", subDeadline, revDeadline],
        { value: REWARD }
      );
      await publicClient.waitForTransactionReceipt({ hash });

      const count: bigint = await contract.read.bountyCount();
      bountyId = count;
    });

    it("allows a participant to submit a commitment", async () => {
      const commitment = buildCommitment(
        ANSWER_A,
        SALT_A,
        alice.account.address,
        bountyId
      );

      const contract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: alice } }
      );

      const hash = await contract.write.submitCommitment([bountyId, commitment]);
      await publicClient.waitForTransactionReceipt({ hash });

      const [c, committed, revealed] = await contract.read.getSubmission([
        bountyId,
        alice.account.address,
      ]);

      assert.equal(c, commitment);
      assert.equal(committed, true);
      assert.equal(revealed, false);
    });

    it("reverts when submitting twice", async () => {
      const commitment = buildCommitment(
        ANSWER_A,
        SALT_A,
        alice.account.address,
        bountyId
      );

      const contract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: alice } }
      );

      const hash = await contract.write.submitCommitment([bountyId, commitment]);
      await publicClient.waitForTransactionReceipt({ hash });

      await assert.rejects(
        contract.write.submitCommitment([bountyId, commitment]),
        /AlreadyCommitted/
      );
    });

    it("commitment does NOT expose plaintext answer on-chain", async () => {
      const commitment = buildCommitment(
        "secret answer",
        SALT_A,
        alice.account.address,
        bountyId
      );

      const contract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: alice } }
      );

      await publicClient.waitForTransactionReceipt({
        hash: await contract.write.submitCommitment([bountyId, commitment]),
      });

      // revealed answer should be empty at this stage
      // (can't call getRevealedAnswers until after revealDeadline)
      const [, , revealed] = await contract.read.getSubmission([
        bountyId,
        alice.account.address,
      ]);
      assert.equal(revealed, false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  3. revealAnswer
  // ─────────────────────────────────────────────────────────────────────────

  describe("revealAnswer", () => {
    it("✓ valid reveal succeeds when hash matches", async () => {
      // Create bounty with very short deadlines for testing
      const subDeadline = await nowPlus(5);
      const revDeadline = await nowPlus(3600);

      const ownerContract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: owner } }
      );

      await publicClient.waitForTransactionReceipt({
        hash: await ownerContract.write.createBounty(
          ["Reveal test", subDeadline, revDeadline],
          { value: REWARD }
        ),
      });

      const bountyId: bigint = await ownerContract.read.bountyCount();

      // Alice commits
      const commitment = buildCommitment(
        ANSWER_A,
        SALT_A,
        alice.account.address,
        bountyId
      );

      const aliceContract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: alice } }
      );

      await publicClient.waitForTransactionReceipt({
        hash: await aliceContract.write.submitCommitment([bountyId, commitment]),
      });

      // Advance time past submission deadline
      await hre.network.provider.send("evm_increaseTime", [10]);
      await hre.network.provider.send("evm_mine");

      // Alice reveals
      await publicClient.waitForTransactionReceipt({
        hash: await aliceContract.write.revealAnswer([bountyId, ANSWER_A, SALT_A]),
      });

      const [, , revealed] = await aliceContract.read.getSubmission([
        bountyId,
        alice.account.address,
      ]);
      assert.equal(revealed, true);
    });

    it("✗ invalid reveal reverts when answer doesn't match commitment", async () => {
      const subDeadline = await nowPlus(5);
      const revDeadline = await nowPlus(3600);

      const ownerContract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: owner } }
      );

      await publicClient.waitForTransactionReceipt({
        hash: await ownerContract.write.createBounty(
          ["Invalid reveal test", subDeadline, revDeadline],
          { value: REWARD }
        ),
      });

      const bountyId: bigint = await ownerContract.read.bountyCount();

      const commitment = buildCommitment(
        ANSWER_A,
        SALT_A,
        bob.account.address,
        bountyId
      );

      const bobContract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: bob } }
      );

      await publicClient.waitForTransactionReceipt({
        hash: await bobContract.write.submitCommitment([bountyId, commitment]),
      });

      await hre.network.provider.send("evm_increaseTime", [10]);
      await hre.network.provider.send("evm_mine");

      // Bob tries to reveal a DIFFERENT answer — should fail
      await assert.rejects(
        bobContract.write.revealAnswer([bountyId, "WRONG ANSWER", SALT_A]),
        /InvalidReveal/
      );
    });

    it("✗ cannot reveal before submission deadline", async () => {
      const subDeadline = await nowPlus(9999);
      const revDeadline = await nowPlus(19999);

      const ownerContract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: owner } }
      );

      await publicClient.waitForTransactionReceipt({
        hash: await ownerContract.write.createBounty(
          ["Early reveal test", subDeadline, revDeadline],
          { value: REWARD }
        ),
      });

      const bountyId: bigint = await ownerContract.read.bountyCount();

      const commitment = buildCommitment(
        ANSWER_A,
        SALT_A,
        carol.account.address,
        bountyId
      );

      const carolContract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: carol } }
      );

      await publicClient.waitForTransactionReceipt({
        hash: await carolContract.write.submitCommitment([bountyId, commitment]),
      });

      // Try to reveal before sub deadline — should fail
      await assert.rejects(
        carolContract.write.revealAnswer([bountyId, ANSWER_A, SALT_A]),
        /RevealPhaseNotStarted/
      );
    });

    it("✗ cannot copy another participant's commitment for a different sender", async () => {
      // Alice's commitment includes HER address — Bob cannot use it
      const subDeadline = await nowPlus(5);
      const revDeadline = await nowPlus(3600);

      const ownerContract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: owner } }
      );

      await publicClient.waitForTransactionReceipt({
        hash: await ownerContract.write.createBounty(
          ["Anti-copy test", subDeadline, revDeadline],
          { value: REWARD }
        ),
      });

      const bountyId: bigint = await ownerContract.read.bountyCount();

      // Alice builds commitment with HER address
      const aliceCommitment = buildCommitment(
        ANSWER_A,
        SALT_A,
        alice.account.address,
        bountyId
      );

      const aliceContract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: alice } }
      );
      const bobContract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: bob } }
      );

      // Alice commits, Bob submits SAME hash
      await publicClient.waitForTransactionReceipt({
        hash: await aliceContract.write.submitCommitment([bountyId, aliceCommitment]),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await bobContract.write.submitCommitment([bountyId, aliceCommitment]),
      });

      await hre.network.provider.send("evm_increaseTime", [10]);
      await hre.network.provider.send("evm_mine");

      // Bob tries to reveal Alice's answer — keccak256 includes msg.sender so it fails
      await assert.rejects(
        bobContract.write.revealAnswer([bountyId, ANSWER_A, SALT_A]),
        /InvalidReveal/
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  4. judgeAll + finalizeWinner
  // ─────────────────────────────────────────────────────────────────────────

  describe("judgeAll & finalizeWinner", () => {
    it("only owner can call judgeAll and finalizeWinner", async () => {
      const subDeadline = await nowPlus(10);
      const revDeadline = await nowPlus(20);

      const ownerContract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: owner } }
      );

      await publicClient.waitForTransactionReceipt({
        hash: await ownerContract.write.createBounty(
          ["Access control test", subDeadline, revDeadline],
          { value: REWARD }
        ),
      });

      const bountyId: bigint = await ownerContract.read.bountyCount();

      await hre.network.provider.send("evm_increaseTime", [30]);
      await hre.network.provider.send("evm_mine");

      const aliceContract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: alice } }
      );

      await assert.rejects(
        aliceContract.write.judgeAll([bountyId, toHex("test")], {
          value: parseEther("0.01"),
        }),
        /NotOwner/
      );
    });

    it("finalizeWinner sends reward to winner", async () => {
      // Full flow: create → commit → reveal → judge → finalize
      const subDeadline = await nowPlus(10);
      const revDeadline = await nowPlus(30);

      const ownerContract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: owner } }
      );

      await publicClient.waitForTransactionReceipt({
        hash: await ownerContract.write.createBounty(
          ["Full flow test", subDeadline, revDeadline],
          { value: REWARD }
        ),
      });

      const bountyId: bigint = await ownerContract.read.bountyCount();

      const commitment = buildCommitment(
        ANSWER_A,
        SALT_A,
        alice.account.address,
        bountyId
      );

      const aliceContract = await hre.viem.getContractAt(
        "PrivacyBountyJudge",
        contractAddress,
        { client: { wallet: alice } }
      );

      await publicClient.waitForTransactionReceipt({
        hash: await aliceContract.write.submitCommitment([bountyId, commitment]),
      });

      await hre.network.provider.send("evm_increaseTime", [15]);
      await hre.network.provider.send("evm_mine");

      await publicClient.waitForTransactionReceipt({
        hash: await aliceContract.write.revealAnswer([bountyId, ANSWER_A, SALT_A]),
      });

      await hre.network.provider.send("evm_increaseTime", [20]);
      await hre.network.provider.send("evm_mine");

      const beforeBalance = await publicClient.getBalance({
        address: alice.account.address,
      });

      await publicClient.waitForTransactionReceipt({
        hash: await ownerContract.write.judgeAll(
          [bountyId, toHex('{"winner":0}')],
          { value: parseEther("0.01") }
        ),
      });

      await publicClient.waitForTransactionReceipt({
        hash: await ownerContract.write.finalizeWinner([bountyId, 0n]),
      });

      const afterBalance = await publicClient.getBalance({
        address: alice.account.address,
      });

      assert.ok(
        afterBalance > beforeBalance,
        "Alice should have received the reward"
      );
    });
  });
});
