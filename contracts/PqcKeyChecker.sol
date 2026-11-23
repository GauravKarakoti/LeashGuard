// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPqcKeyStatusPrecompile {
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey);
}

/// @title PqcKeyChecker – Queries QoreChain's PQC key status precompile on-chain
contract PqcKeyChecker {
    address public constant PQC_KEY_STATUS_PRECOMPILE =
        0x0000000000000000000000000000000000000a02;

    event PqcChecked(
        address indexed account,
        bool registered,
        uint8 algorithmId
    );

    error PqcKeyNotRegistered(address account);

    function checkPqcKey(address account)
        external
        view
        returns (bool registered, uint8 algorithmId)
    {
        (registered, algorithmId, ) = IPqcKeyStatusPrecompile(
            PQC_KEY_STATUS_PRECOMPILE
        ).pqcKeyStatus(account);
    }

    function requirePqcKey(address account) external returns (uint8 algorithmId) {
        bool registered;
        (registered, algorithmId, ) = IPqcKeyStatusPrecompile(
            PQC_KEY_STATUS_PRECOMPILE
        ).pqcKeyStatus(account);

        if (!registered) revert PqcKeyNotRegistered(account);
        emit PqcChecked(account, registered, algorithmId);
    }
}