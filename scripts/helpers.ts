/**
 * scripts/helpers.ts
 *
 * Off-chain helpers for interacting with PrivacyBountyJudge.
 *
 * Usage (run with ts-node or hardhat run):
 *   npx hardhat run scripts/helpers.ts --network localhost
 */

import { keccak256, encodePacked, toHex, getContract, createWalletClient, http } from "viem";
import hre from "hardhat";

// ─────────────────────────────────────────────────────────────────────────────
//  1. Build commitment hash (call this BEFORE submitCommitment)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the commitment that matches the Solidity formula:
 *   keccak256(abi.encodePacked(answer, salt, msg.sender, bountyId))
 *
 * @param answer      Your plaintext answer (keep this secret!)
 * @param salt        Random 32-byte hex string (keep this secret!)
 * @param sender      Your wallet address (msg.sender)
 * @param bountyId    The bountyId you're committing to
 */
export function buildCommitment(
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

/**
 * Generate a cryptographically random 32-byte salt.
 * Save this alongside your answer — you need both to reveal.
 */
export function generateSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes) as `0x${string}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. Build llmInput for judgeAll (call this AFTER reveal deadline)
// ─────────────────────────────────────────────────────────────────────────────

interface RevealedSubmission {
  index: number;
  participant: string;
  answer: string;
}

/**
 * Build the JSON prompt bytes to pass to judgeAll().
 * Include ONLY participants who have revealed (hasRevealed == true).
 */
export function buildLlmInput(
  bountyId: bigint,
  description: string,
  submissions: RevealedSubmission[],
  rubric = "Score each submission on: correctness, creativity, and completeness. Return JSON with winnerIndex, ranking array, and summary."
): Uint8Array {
  const payload = {
    bountyId: bountyId.toString(),
    description,
    rubric,
    submissions,
  };
  return new TextEncoder().encode(JSON.stringify(payload));
}

// ─────────────────────────────────────────────────────────────────────────────
//  3. Example: Full interaction script
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const [owner, alice, bob] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  console.log("Owner  :", owner.account.address);
  console.log("Alice  :", alice.account.address);
  console.log("Bob    :", bob.account.address);

  // ── Deploy ────────────────────────────────────────────────────────────────
  const mockOracle = await hre.viem.deployContract("MockOracle");
  const contract   = await hre.viem.deployContract("PrivacyBountyJudge", [
    mockOracle.address,
  ]);
  console.log("\nContract deployed at:", contract.address);

  // ── PHASE 0: Create Bounty ────────────────────────────────────────────────
  const now         = BigInt(Math.floor(Date.now() / 1000));
  const subDeadline = now + 60n;   // 1 min
  const revDeadline = now + 120n;  // 2 min

  const ownerContract = await hre.viem.getContractAt(
    "PrivacyBountyJudge",
    contract.address,
    { client: { wallet: owner } }
  );

  await publicClient.waitForTransactionReceipt({
    hash: await ownerContract.write.createBounty(
      ["Build a decentralized lending protocol", subDeadline, revDeadline],
      { value: BigInt(1e17) } // 0.1 ETH
    ),
  });

  const bountyId = await ownerContract.read.bountyCount();
  console.log("\n[Phase 0] Bounty created, ID:", bountyId);

  // ── PHASE 1: Commit ───────────────────────────────────────────────────────
  const aliceSalt   = generateSalt();
  const aliceAnswer = "Use Aave v3 fork with custom risk parameters";
  const aliceCommit = buildCommitment(aliceAnswer, aliceSalt, alice.account.address, bountyId);

  const bobSalt   = generateSalt();
  const bobAnswer = "Compound-style isolated markets with shared liquidity";
  const bobCommit = buildCommitment(bobAnswer, bobSalt, bob.account.address, bountyId);

  console.log("\n[Phase 1] Alice salt (SAVE THIS):", aliceSalt);
  console.log("[Phase 1] Alice commitment:", aliceCommit);

  const aliceContract = await hre.viem.getContractAt(
    "PrivacyBountyJudge",
    contract.address,
    { client: { wallet: alice } }
  );
  const bobContract = await hre.viem.getContractAt(
    "PrivacyBountyJudge",
    contract.address,
    { client: { wallet: bob } }
  );

  await publicClient.waitForTransactionReceipt({
    hash: await aliceContract.write.submitCommitment([bountyId, aliceCommit]),
  });
  await publicClient.waitForTransactionReceipt({
    hash: await bobContract.write.submitCommitment([bountyId, bobCommit]),
  });

  console.log("[Phase 1] Alice and Bob committed — answers hidden.");

  // ── Fast-forward past subDeadline ─────────────────────────────────────────
  await hre.network.provider.send("evm_increaseTime", [61]);
  await hre.network.provider.send("evm_mine");

  // ── PHASE 2: Reveal ───────────────────────────────────────────────────────
  await publicClient.waitForTransactionReceipt({
    hash: await aliceContract.write.revealAnswer([bountyId, aliceAnswer, aliceSalt]),
  });
  await publicClient.waitForTransactionReceipt({
    hash: await bobContract.write.revealAnswer([bountyId, bobAnswer, bobSalt]),
  });
  console.log("\n[Phase 2] Answers revealed.");

  // ── Fast-forward past revDeadline ─────────────────────────────────────────
  await hre.network.provider.send("evm_increaseTime", [61]);
  await hre.network.provider.send("evm_mine");

  // ── PHASE 3: Judge (batch) ────────────────────────────────────────────────
  const [participants, answers, revealed] =
    await ownerContract.read.getRevealedAnswers([bountyId]);

  const submissions: RevealedSubmission[] = participants
    .map((addr: string, i: number) => ({ index: i, participant: addr, answer: answers[i] }))
    .filter((_: any, i: number) => revealed[i]);

  const llmInput = buildLlmInput(
    bountyId,
    "Build a decentralized lending protocol",
    submissions
  );

  await publicClient.waitForTransactionReceipt({
    hash: await ownerContract.write.judgeAll([bountyId, llmInput], {
      value: BigInt(1e16), // oracle fee
    }),
  });
  console.log("[Phase 3] Judging requested via Ritual.");

  // ── PHASE 4: Finalize ─────────────────────────────────────────────────────
  // Owner reviews AI output (winnerIndex = 0 = Alice in this example)
  await publicClient.waitForTransactionReceipt({
    hash: await ownerContract.write.finalizeWinner([bountyId, 0n]),
  });
  console.log("\n[Phase 4] Winner finalized! Alice receives the reward.");
}

main().catch(console.error);
