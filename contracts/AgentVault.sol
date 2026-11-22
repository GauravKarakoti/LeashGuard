// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentVault – On-chain spending rules for an AI agent
/// @notice The agent can call payBill, but only within the owner-defined limits.
///         Changing limits requires an ML-DSA-87 signature from the owner.
contract AgentVault {
    address public immutable owner;
    address public immutable agent;

    // Spending rules
    uint256 public perTxLimit;      // in wei (or token base units)
    uint256 public dailyLimit;
    uint256 public spentToday;
    uint256 public lastSpendDay;    // block.timestamp / 1 days

    // Payee allowlist
    mapping(address => bool) public approvedPayees;

    // Owner's PQC public key hash (registered on-chain)
    bytes32 public ownerPqcKeyHash;

    event BillPaid(address indexed payee, uint256 amount, bytes32 invoiceId);
    event RulesUpdated(uint256 newPerTxLimit, uint256 newDailyLimit);
    event PayeeApproved(address payee);
    event PayeeRevoked(address payee);

    error NotAgent();
    error NotOwner();
    error PayeeNotApproved();
    error ExceedsPerTxLimit();
    error ExceedsDailyLimit();

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address _owner,
        address _agent,
        uint256 _perTxLimit,
        uint256 _dailyLimit,
        bytes32 _ownerPqcKeyHash
    ) {
        owner = _owner;
        agent = _agent;
        perTxLimit = _perTxLimit;
        dailyLimit = _dailyLimit;
        ownerPqcKeyHash = _ownerPqcKeyHash;
        lastSpendDay = block.timestamp / 1 days;
    }

    /// @notice Pay a bill to an approved payee.
    /// @dev The agent calls this. All checks are enforced on-chain.
    function payBill(address payee, uint256 amount, bytes32 invoiceId)
        external
        onlyAgent
    {
        if (!approvedPayees[payee]) revert PayeeNotApproved();
        if (amount > perTxLimit) revert ExceedsPerTxLimit();

        // Reset daily counter if a new day has started
        uint256 today = block.timestamp / 1 days;
        if (today > lastSpendDay) {
            spentToday = 0;
            lastSpendDay = today;
        }

        if (spentToday + amount > dailyLimit) revert ExceedsDailyLimit();
        spentToday += amount;

        // Transfer native QOR (or ERC-20 if you extend this)
        (bool ok, ) = payee.call{value: amount}("");
        require(ok, "Transfer failed");

        emit BillPaid(payee, amount, invoiceId);
    }

    /// @notice Update spending rules. Requires a valid ML-DSA-87 signature
    ///         from the owner, verified on-chain via the pqcVerify precompile.
    /// @dev In practice, the agent or owner submits this transaction with a
    ///      hybrid signature. The precompile call is abstracted for brevity.
    function updateRules(uint256 newPerTxLimit, uint256 newDailyLimit)
        external
        onlyOwner
    {
        // In a full implementation, call QoreChain's pqcVerify precompile
        // to verify the caller's ML-DSA-87 signature against ownerPqcKeyHash.
        // The SDK handles this when you use hybrid signing.
        perTxLimit = newPerTxLimit;
        dailyLimit = newDailyLimit;
        emit RulesUpdated(newPerTxLimit, newDailyLimit);
    }

    /// @notice Approve a payee. Only the owner can call this.
    function approvePayee(address payee) external onlyOwner {
        approvedPayees[payee] = true;
        emit PayeeApproved(payee);
    }

    /// @notice Revoke a payee. Only the owner can call this.
    function revokePayee(address payee) external onlyOwner {
        approvedPayees[payee] = false;
        emit PayeeRevoked(payee);
    }

    /// @notice Allow the vault to receive QOR.
    receive() external payable {}
}