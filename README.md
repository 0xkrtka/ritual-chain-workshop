# Privacy-Preserving AI Bounty Judge

> **Ritual Workshop Homework** — Commit-Reveal Bounty with Ritual AI Judging

---

## Problem Statement

The original bounty contract stores answers in plaintext immediately after submission. This means later participants can read earlier answers, copy ideas, and submit improved versions — an unfair advantage in a winner-takes-all system.

**Solution:** A commit-reveal scheme where answers stay hidden until the submission phase ends, combined with Ritual's AI-powered batch judging.

---

## Bounty Lifecycle

```
PHASE 0: Create
  Owner deposits reward → sets submission + reveal deadlines

PHASE 1: Commit  [now → submissionDeadline]
  Participants submit: keccak256(answer + salt + address + bountyId)
  ➜ Answer is HIDDEN. Only a hash is on-chain.

PHASE 2: Reveal  [submissionDeadline → revealDeadline]
  Participants send plaintext answer + salt
  ➜ Contract verifies hash matches commitment
  ➜ Invalid reveals are rejected; only valid reveals eligible

PHASE 3: Judge   [after revealDeadline]
  Owner calls judgeAll() → ONE batch request to Ritual AI
  ➜ All revealed answers judged together in a single LLM call

PHASE 4: Finalize
  Owner reviews AI output → calls finalizeWinner(index)
  ➜ Human decision, AI is advisory only
  ➜ Reward transferred to winner
```

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure wallet

```bash
cp .env.example .env
# Edit .env and add your PRIVATE_KEY
```

> ⚠️ **Important:** Your `PRIVATE_KEY` is how your wallet address gets recorded on-chain as the deployer/participant. Never commit `.env` to git.

### 3. Compile

```bash
npm run compile
```

### 4. Run tests

```bash
npm test
```

### 5. Deploy locally

```bash
npm run deploy:local
```

### 6. Deploy to Sepolia

```bash
npm run deploy:sepolia
```

---

## Contract Functions

| Function | Who | When | Purpose |
|---|---|---|---|
| `createBounty(desc, subDeadline, revDeadline)` | Owner | Anytime | Create + lock reward |
| `submitCommitment(bountyId, commitment)` | Anyone | Before subDeadline | Submit hash only |
| `revealAnswer(bountyId, answer, salt)` | Committers | After sub, before rev | Reveal + verify |
| `judgeAll(bountyId, llmInput)` | Owner | After revDeadline | Batch AI judge |
| `finalizeWinner(bountyId, winnerIndex)` | Owner | After judging | Pay winner |

---

## Commitment Formula

Compute off-chain **before** calling `submitCommitment`:

```typescript
import { keccak256, encodePacked } from "viem";

const commitment = keccak256(
  encodePacked(
    ["string", "bytes32", "address", "uint256"],
    [answer, salt, walletAddress, BigInt(bountyId)]
  )
);
```

Including `msg.sender` and `bountyId` in the hash prevents:
- **Replay attacks**: A commitment for bounty #1 cannot be reused for bounty #2
- **Commitment copying**: Bob copying Alice's commitment hash cannot reveal with Alice's answer — the hash will not match because Bob's address differs

---

## Building `llmInput` for `judgeAll`

After the reveal deadline, build the batch prompt off-chain and pass it as bytes:

```typescript
const payload = {
  bountyId: "1",
  description: "Build a decentralized lending protocol",
  rubric: "Score on correctness, creativity, completeness",
  submissions: [
    { index: 0, participant: "0xAlice...", answer: "Use Aave v3 fork..." },
    { index: 1, participant: "0xBob...",  answer: "Compound-style..." },
  ]
};

const llmInput = new TextEncoder().encode(JSON.stringify(payload));
await contract.write.judgeAll([bountyId, llmInput], { value: oracleFee });
```

> **Rule:** One batch call. Never loop and call the LLM once per submission.

---

## Architecture Note: Commit-Reveal vs Ritual TEE

### Required Track: Commit-Reveal

| Property | Detail |
|---|---|
| **Answer hidden until** | Reveal phase opens (after submission deadline) |
| **What's on-chain** | Commitment hash → then plaintext after reveal |
| **Trust model** | Trustless — math enforces privacy |
| **Limitation** | Answers become public before AI judging |
| **Works on** | Any EVM chain |

**Flow:**
```
Participant → [hash only] → Contract
                                     ↓ (after subDeadline)
Participant → [plaintext] → Contract → Ritual AI (batch) → Owner → Winner
```

### Advanced Track: Ritual TEE (design)

| Property | Detail |
|---|---|
| **Answer hidden until** | After AI judging is complete |
| **What's on-chain** | Encrypted ciphertext or IPFS reference + hash |
| **What's off-chain** | Plaintext answers (in participant's hands + TEE only) |
| **Trust model** | Ritual TEE — hardware-enforced privacy |
| **Limitation** | Requires Ritual infrastructure; more complex |
| **Works on** | Ritual-connected chains only |

**Flow:**
```
Participant → [encrypted with TEE pubkey] → IPFS/Arweave
          → [ciphertext hash] → Contract

judgeAll():
  TEE fetches encrypted submissions
  TEE decrypts privately (no public exposure)
  TEE sends plaintext batch to LLM
  LLM returns ranking
  TEE publishes: winnerIndex + revealedAnswersRef + revealedAnswersHash
  Contract stores hash for verification

finalizeWinner():
  Owner confirms → reward sent
```

**Key difference:** In commit-reveal, answers are public during the reveal phase (before AI judging). With Ritual TEE, answers stay encrypted until AI judging is done — no participant ever sees another's plaintext answer before the result.

---

## Advanced Track: Private Submission Flow (Design)

```
┌──────────────┐        ┌─────────────────────┐        ┌─────────────────┐
│  Participant │        │  Ritual TEE Executor │        │  Smart Contract │
└──────┬───────┘        └──────────┬──────────┘        └────────┬────────┘
       │                           │                             │
       │  1. Fetch TEE public key  │                             │
       │◄──────────────────────────│                             │
       │                           │                             │
       │  2. Encrypt answer with   │                             │
       │     TEE pubkey            │                             │
       │                           │                             │
       │  3. Upload ciphertext to IPFS → get CID                │
       │                           │                             │
       │  4. submitEncrypted(bountyId, cid, ciphertextHash) ────►│
       │                           │                             │
       │                           │  5. After deadline:         │
       │                           │     judgeAll() called ◄─────│
       │                           │                             │
       │                           │  6. TEE fetches all CIDs    │
       │                           │     from contract           │
       │                           │                             │
       │                           │  7. TEE decrypts answers    │
       │                           │     (private inside TEE)    │
       │                           │                             │
       │                           │  8. Single batch LLM call   │
       │                           │     with all plaintexts     │
       │                           │                             │
       │                           │  9. Publish result:         │
       │                           │     {winnerIndex,           │
       │                           │      revealedAnswersRef,    │
       │                           │      revealedAnswersHash} ──►│
       │                           │                             │
       │                ◄──────────────────────── finalizeWinner │
       │  Winner receives reward   │                             │
```

**Where does plaintext live?**
- Participant's device only (before submission)
- Inside Ritual TEE during judging (hardware-protected, not visible to chain)
- IPFS revealed bundle (after judging completes, anyone can verify against hash)

**What is stored on-chain?**
- Encrypted ciphertext hash (commit phase)
- IPFS CID reference to encrypted submission
- After judging: `revealedAnswersHash` + `revealedAnswersRef`

---

## Reflection Question

*What should be public, what should stay hidden, and what should be decided by AI versus by a human in a bounty system?*

In a bounty system, the bounty description, reward amount, deadlines, and commitment hashes should be fully public — this ensures participants can verify the rules are enforced fairly and that the reward is locked. The actual submission content must stay hidden during the submission phase to prevent copying; in the commit-reveal model, answers become public at reveal time, while a Ritual TEE approach keeps them private even through judging. The identity of who submitted what should only be linkable after judging is complete, to prevent bias and social-pressure attacks. AI is well-suited to evaluate submissions objectively against a rubric — scoring for correctness, creativity, and completeness — especially when all answers must be compared in batch without human bias from reading earlier submissions. However, the final winner selection should always be a human decision: the AI recommendation surfaces the best answers, but the bounty owner must explicitly confirm the choice, verify no manipulation occurred, and take accountability for the payout. This human-in-the-loop finalization also protects against adversarial LLM outputs that might attempt to manipulate the `winnerIndex`. The payment itself should be automatic once the human approves, since trustless smart contracts eliminate the risk of the owner refusing to pay after seeing results.

---

## Test Plan

| # | Scenario | Expected |
|---|---|---|
| 1 | Create bounty with zero reward | Reverts `ZeroReward` |
| 2 | Submit commitment before deadline | Succeeds, hash stored |
| 3 | Submit commitment twice | Reverts `AlreadyCommitted` |
| 4 | Submit commitment after deadline | Reverts `SubmissionPhaseClosed` |
| 5 | Reveal before submission deadline | Reverts `RevealPhaseNotStarted` |
| 6 | Reveal with wrong answer | Reverts `InvalidReveal` |
| 7 | Reveal with wrong salt | Reverts `InvalidReveal` |
| 8 | Reveal after reveal deadline | Reverts `RevealPhaseStillOpen` |
| 9 | Reveal twice | Reverts `AlreadyRevealed` |
| 10 | Bob copies Alice's commitment, tries to reveal | Reverts `InvalidReveal` (sender mismatch) |
| 11 | Non-owner calls `judgeAll` | Reverts `NotOwner` |
| 12 | `judgeAll` before reveal deadline | Reverts `RevealPhaseStillOpen` |
| 13 | `judgeAll` twice | Reverts `JudgingAlreadyDone` |
| 14 | `finalizeWinner` before judging | Reverts `JudgingNotComplete` |
| 15 | Finalize with winner who didn't reveal | Reverts `WinnerDidNotReveal` |
| 16 | Full happy path | Winner receives reward |

---

## Security Considerations

- **No reentrancy risk**: State (`finalized = true`) is set before ETH transfer
- **No automatic payment from AI**: `finalizeWinner` requires owner action after reviewing AI result
- **Salt prevents rainbow table attacks** on commitment hashes
- **`msg.sender` in commitment** prevents commitment copying between participants
- **`bountyId` in commitment** prevents replay across different bounties
- **`getRevealedAnswers` only readable after revealDeadline** — no early leakage from view calls
