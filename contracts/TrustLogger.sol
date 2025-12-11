// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract TrustLogger {
    event TrustEvent(
        string indexed groupId,
        uint256 oldTS,
        uint256 newTS,
        string reason,
        bytes32 dataHash,
        uint256 ts
    );

    function logTrustEvent(
        string calldata groupId,
        uint256 oldTS,
        uint256 newTS,
        string calldata reason,
        bytes32 dataHash,
        uint256 ts
    ) external {
        emit TrustEvent(groupId, oldTS, newTS, reason, dataHash, ts);
    }
}
