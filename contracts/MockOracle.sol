// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MockOracle
 * @notice Stub oracle for local testing. Accepts compute requests and returns a fake requestId.
 */
contract MockOracle {
    uint256 private _requestCounter;

    event ComputeRequested(
        uint256 indexed requestId,
        string  modelId,
        bytes   input,
        uint256 gasLimit
    );

    function requestCompute(
        string calldata modelId,
        bytes  calldata input,
        uint256         gasLimit
    ) external payable returns (uint256 requestId) {
        requestId = ++_requestCounter;
        emit ComputeRequested(requestId, modelId, input, gasLimit);
    }
}
