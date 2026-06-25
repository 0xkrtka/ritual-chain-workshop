// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title  PrivacyBountyJudge
 * @author Ritual Workshop Participant
 * @notice Privacy-preserving AI Bounty Judge using commit-reveal scheme.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  LIFECYCLE                                                  │
 * │  1. Owner creates bounty  (reward locked in contract)       │
 * │  2. Participants submit commitment hash  (answer hidden)     │
 * │  3. After sub deadline: participants reveal answer + salt    │
 * │  4. After reveal deadline: owner calls judgeAll() via Ritual│
 * │  5. Owner reviews AI result → finalizes winner → payout     │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Commitment formula (computed OFF-CHAIN by participant):
 *   bytes32 commitment = keccak256(
 *       abi.encodePacked(answer, salt, msg.sender, bountyId)
 *   );
 */

// ─────────────────────────────────────────────────────────
//  Ritual Oracle Interface (simplified)
// ─────────────────────────────────────────────────────────
interface IOracle {
    function requestCompute(
        string calldata modelId,
        bytes  calldata input,
        uint256         gasLimit
    ) external payable returns (uint256 requestId);
}

// ─────────────────────────────────────────────────────────
//  Main Contract
// ─────────────────────────────────────────────────────────
contract PrivacyBountyJudge {

    // ── Structs ──────────────────────────────────────────

    struct Submission {
        bytes32 commitment;      // keccak256(answer ++ salt ++ sender ++ bountyId)
        string  revealedAnswer;  // set during reveal phase
        bool    hasCommitted;
        bool    hasRevealed;
    }

    struct Bounty {
        address   owner;
        string    description;
        uint256   reward;              // ETH in wei, locked in contract
        uint256   submissionDeadline;  // Phase 1 ends here
        uint256   revealDeadline;      // Phase 2 ends here; judging allowed after
        bool      judged;
        bool      finalized;
        int256    winnerIndex;         // -1 = not set yet
        address[] participants;        // push-ordered list of committers
    }

    // ── State ────────────────────────────────────────────

    IOracle public immutable oracle;
    string  public constant MODEL_ID = "ritual/gpt-4o";

    uint256 private _bountyCounter;

    mapping(uint256 => Bounty)                              private _bounties;
    mapping(uint256 => mapping(address => Submission))      private _submissions;

    // Ritual requestId → bountyId (for off-chain indexing)
    mapping(uint256 => uint256) public requestToBounty;

    // ── Events ───────────────────────────────────────────

    event BountyCreated(
        uint256 indexed bountyId,
        address indexed owner,
        uint256 reward,
        uint256 submissionDeadline,
        uint256 revealDeadline
    );
    event CommitmentSubmitted(uint256 indexed bountyId, address indexed participant);
    event AnswerRevealed(uint256 indexed bountyId, address indexed participant);
    event JudgingRequested(uint256 indexed bountyId, uint256 ritualRequestId);
    event WinnerFinalized(uint256 indexed bountyId, address indexed winner, uint256 reward);

    // ── Custom Errors ────────────────────────────────────

    error NotOwner();
    error BountyNotFound();
    error SubmissionPhaseClosed();
    error RevealPhaseNotStarted();
    error RevealPhaseStillOpen();
    error AlreadyCommitted();
    error AlreadyRevealed();
    error NoCommitmentFound();
    error InvalidReveal();
    error JudgingAlreadyDone();
    error JudgingNotComplete();
    error BountyAlreadyFinalized();
    error InvalidWinnerIndex();
    error WinnerDidNotReveal();
    error ZeroReward();
    error BadDeadlines();
    error TransferFailed();

    // ── Constructor ──────────────────────────────────────

    constructor(address _oracle) {
        require(_oracle != address(0), "Invalid oracle address");
        oracle = IOracle(_oracle);
    }

    // ═══════════════════════════════════════════════════════
    //  PHASE 0 — Create Bounty
    // ═══════════════════════════════════════════════════════

    /**
     * @notice Create a new bounty. Reward is sent as msg.value and locked.
     * @param description   Problem statement / judging rubric.
     * @param subDeadline   Commits accepted until this timestamp.
     * @param revDeadline   Reveals accepted until this timestamp.
     */
    function createBounty(
        string  calldata description,
        uint256          subDeadline,
        uint256          revDeadline
    ) external payable returns (uint256 bountyId) {
        if (msg.value == 0)                  revert ZeroReward();
        if (subDeadline <= block.timestamp)  revert BadDeadlines();
        if (revDeadline <= subDeadline)      revert BadDeadlines();

        bountyId = ++_bountyCounter;

        Bounty storage b     = _bounties[bountyId];
        b.owner              = msg.sender;
        b.description        = description;
        b.reward             = msg.value;
        b.submissionDeadline = subDeadline;
        b.revealDeadline     = revDeadline;
        b.winnerIndex        = -1;

        emit BountyCreated(bountyId, msg.sender, msg.value, subDeadline, revDeadline);
    }

    // ═══════════════════════════════════════════════════════
    //  PHASE 1 — Commit  (answer stays hidden)
    // ═══════════════════════════════════════════════════════

    /**
     * @notice Submit commitment hash — only before submissionDeadline.
     *
     * Build commitment off-chain (TypeScript example):
     *   const commitment = keccak256(encodePacked(
     *       ['string','bytes32','address','uint256'],
     *       [answer, salt, walletAddress, BigInt(bountyId)]
     *   ));
     */
    function submitCommitment(uint256 bountyId, bytes32 commitment) external {
        Bounty storage b = _requireBounty(bountyId);

        if (block.timestamp >= b.submissionDeadline)         revert SubmissionPhaseClosed();
        if (_submissions[bountyId][msg.sender].hasCommitted) revert AlreadyCommitted();

        _submissions[bountyId][msg.sender].commitment   = commitment;
        _submissions[bountyId][msg.sender].hasCommitted = true;
        b.participants.push(msg.sender);

        emit CommitmentSubmitted(bountyId, msg.sender);
    }

    // ═══════════════════════════════════════════════════════
    //  PHASE 2 — Reveal  (after sub deadline, before rev deadline)
    // ═══════════════════════════════════════════════════════

    /**
     * @notice Reveal plaintext answer and salt.
     *         The contract recomputes keccak256 and compares with stored commitment.
     *         Only valid reveals are eligible for AI judging.
     */
    function revealAnswer(
        uint256         bountyId,
        string calldata answer,
        bytes32         salt
    ) external {
        Bounty storage b = _requireBounty(bountyId);

        if (block.timestamp < b.submissionDeadline) revert RevealPhaseNotStarted();
        if (block.timestamp >= b.revealDeadline)    revert RevealPhaseStillOpen();

        Submission storage s = _submissions[bountyId][msg.sender];
        if (!s.hasCommitted) revert NoCommitmentFound();
        if (s.hasRevealed)   revert AlreadyRevealed();

        // ── Core check: recompute and verify ─────────────
        bytes32 expected = keccak256(
            abi.encodePacked(answer, salt, msg.sender, bountyId)
        );
        if (expected != s.commitment) revert InvalidReveal();
        // ─────────────────────────────────────────────────

        s.revealedAnswer = answer;
        s.hasRevealed    = true;

        emit AnswerRevealed(bountyId, msg.sender);
    }

    // ═══════════════════════════════════════════════════════
    //  PHASE 3 — Batch Judge via Ritual AI
    // ═══════════════════════════════════════════════════════

    /**
     * @notice Send ALL revealed answers to Ritual in ONE batch request.
     *         Only callable by owner after revealDeadline.
     *
     * @param llmInput  JSON bytes built off-chain, containing ALL revealed answers:
     *   {
     *     "bountyId": 1,
     *     "description": "Build a lending protocol...",
     *     "submissions": [
     *       { "index": 0, "participant": "0x...", "answer": "..." },
     *       { "index": 1, "participant": "0x...", "answer": "..." }
     *     ],
     *     "rubric": "Score on: correctness, creativity, completeness"
     *   }
     *
     * NOTE: Do NOT loop and call LLM per submission. One batch call only.
     */
    function judgeAll(uint256 bountyId, bytes calldata llmInput) external payable {
        Bounty storage b = _requireBounty(bountyId);

        if (msg.sender != b.owner)               revert NotOwner();
        if (block.timestamp < b.revealDeadline)  revert RevealPhaseStillOpen();
        if (b.judged)                            revert JudgingAlreadyDone();

        b.judged = true;

        uint256 requestId = oracle.requestCompute{value: msg.value}(
            MODEL_ID,
            llmInput,
            500_000
        );

        requestToBounty[requestId] = bountyId;

        emit JudgingRequested(bountyId, requestId);
    }

    // ═══════════════════════════════════════════════════════
    //  PHASE 4 — Finalize Winner (human-in-the-loop)
    // ═══════════════════════════════════════════════════════

    /**
     * @notice Owner reviews AI recommendation, then finalizes a winner.
     *         AI output is advisory only — the human owner decides.
     *         Reward is transferred upon finalization.
     *
     * @param winnerIndex  Index into participants[] array (from AI output).
     */
    function finalizeWinner(uint256 bountyId, uint256 winnerIndex) external {
        Bounty storage b = _requireBounty(bountyId);

        if (msg.sender != b.owner)                revert NotOwner();
        if (!b.judged)                            revert JudgingNotComplete();
        if (b.finalized)                          revert BountyAlreadyFinalized();
        if (winnerIndex >= b.participants.length) revert InvalidWinnerIndex();

        address winner = b.participants[winnerIndex];
        if (!_submissions[bountyId][winner].hasRevealed) revert WinnerDidNotReveal();

        b.finalized   = true;
        b.winnerIndex = int256(winnerIndex);

        (bool ok,) = winner.call{value: b.reward}("");
        if (!ok) revert TransferFailed();

        emit WinnerFinalized(bountyId, winner, b.reward);
    }

    // ═══════════════════════════════════════════════════════
    //  VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════

    function getBountyInfo(uint256 bountyId)
        external view
        returns (
            address owner,
            string  memory description,
            uint256 reward,
            uint256 submissionDeadline,
            uint256 revealDeadline,
            bool    judged,
            bool    finalized,
            int256  winnerIndex,
            uint256 participantCount
        )
    {
        Bounty storage b = _requireBounty(bountyId);
        return (
            b.owner, b.description, b.reward,
            b.submissionDeadline, b.revealDeadline,
            b.judged, b.finalized, b.winnerIndex,
            b.participants.length
        );
    }

    /**
     * @notice Revealed answers readable ONLY after revealDeadline.
     *         During submission/reveal phases this reverts — preserving privacy.
     */
    function getRevealedAnswers(uint256 bountyId)
        external view
        returns (
            address[] memory participants,
            string[]  memory answers,
            bool[]    memory revealed
        )
    {
        Bounty storage b = _requireBounty(bountyId);
        require(block.timestamp >= b.revealDeadline, "Reveal phase still active");

        uint256 len  = b.participants.length;
        participants = b.participants;
        answers      = new string[](len);
        revealed     = new bool[](len);

        for (uint256 i = 0; i < len; i++) {
            Submission storage s = _submissions[bountyId][b.participants[i]];
            answers[i]  = s.revealedAnswer;
            revealed[i] = s.hasRevealed;
        }
    }

    function getSubmission(uint256 bountyId, address participant)
        external view
        returns (bytes32 commitment, bool hasCommitted, bool hasRevealed)
    {
        Submission storage s = _submissions[bountyId][participant];
        return (s.commitment, s.hasCommitted, s.hasRevealed);
    }

    function getParticipants(uint256 bountyId) external view returns (address[] memory) {
        return _requireBounty(bountyId).participants;
    }

    function bountyCount() external view returns (uint256) {
        return _bountyCounter;
    }

    // ── Internal ─────────────────────────────────────────

    function _requireBounty(uint256 bountyId) internal view returns (Bounty storage) {
        require(bountyId > 0 && bountyId <= _bountyCounter, "Bounty not found");
        return _bounties[bountyId];
    }
}
