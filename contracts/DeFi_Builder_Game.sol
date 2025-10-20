pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract DeFiBuilderGameFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds;

    bool public paused;
    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Encrypted state for a simplified private lending protocol
    // For a given batch, players submit encrypted collateral and debt amounts.
    // The contract aggregates these to compute total encrypted values.
    // Players can then query if the protocol is solvent (totalCollateral >= totalDebt).
    mapping(uint256 => mapping(address => euint32)) public encryptedCollateralAmounts;
    mapping(uint256 => mapping(address => euint32)) public encryptedDebtAmounts;
    mapping(uint256 => euint32) public totalEncryptedCollateral;
    mapping(uint256 => euint32) public totalEncryptedDebt;
    mapping(uint256 => ebool) public isProtocolSolvent;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event Paused(address account);
    event Unpaused(address account);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event CollateralSubmitted(address indexed provider, uint256 batchId, bytes32 ciphertext);
    event DebtSubmitted(address indexed provider, uint256 batchId, bytes32 ciphertext);
    event SolvencyCalculated(uint256 batchId, bytes32 isSolventCiphertext);
    event DecryptionRequested(uint256 requestId, uint256 batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 requestId, uint256 batchId, bool isSolvent);

    error NotOwner();
    error NotProvider();
    error PausedState();
    error CooldownActive();
    error BatchClosedOrNonExistent();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();
    error InvalidBatchOperation();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedState();
        _;
    }

    modifier respectCooldown(address user, mapping(address => uint256) storage cooldownMapping) {
        if (block.timestamp < cooldownMapping[user] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true; // Owner is a provider by default
        cooldownSeconds = 60; // Default cooldown: 1 minute
        paused = false;
        currentBatchId = 0;
        batchOpen = false;
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider] && provider != owner) { // Owner cannot be removed as provider this way
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert InvalidBatchOperation(); // Cannot open if already open
        currentBatchId++;
        batchOpen = true;
        // Initialize aggregated values for the new batch
        totalEncryptedCollateral[currentBatchId] = FHE.asEuint32(0);
        totalEncryptedDebt[currentBatchId] = FHE.asEuint32(0);
        isProtocolSolvent[currentBatchId] = FHE.asEbool(false); // Default to false

        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert InvalidBatchOperation(); // Cannot close if not open
        batchOpen = false;
        // Calculate solvency for the batch being closed
        _calculateSolvency(currentBatchId);
        emit BatchClosed(currentBatchId);
    }

    function submitCollateral(uint256 batchId, euint32 encryptedAmount)
        external
        onlyProvider
        whenNotPaused
        respectCooldown(msg.sender, lastSubmissionTime)
    {
        if (!_isValidBatch(batchId)) revert BatchClosedOrNonExistent();
        _initIfNeeded(encryptedAmount);

        encryptedCollateralAmounts[batchId][msg.sender] = encryptedAmount;
        totalEncryptedCollateral[batchId] = totalEncryptedCollateral[batchId].add(encryptedAmount);

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit CollateralSubmitted(msg.sender, batchId, encryptedAmount.toBytes32());
    }

    function submitDebt(uint256 batchId, euint32 encryptedAmount)
        external
        onlyProvider
        whenNotPaused
        respectCooldown(msg.sender, lastSubmissionTime)
    {
        if (!_isValidBatch(batchId)) revert BatchClosedOrNonExistent();
        _initIfNeeded(encryptedAmount);

        encryptedDebtAmounts[batchId][msg.sender] = encryptedAmount;
        totalEncryptedDebt[batchId] = totalEncryptedDebt[batchId].add(encryptedAmount);

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit DebtSubmitted(msg.sender, batchId, encryptedAmount.toBytes32());
    }

    function calculateSolvency(uint256 batchId)
        external
        onlyProvider
        whenNotPaused
        respectCooldown(msg.sender, lastSubmissionTime)
    {
        if (!_isValidBatch(batchId)) revert BatchClosedOrNonExistent();
        _calculateSolvency(batchId);
    }

    function requestSolvencyDecryption(uint256 batchId)
        external
        onlyProvider
        whenNotPaused
        respectCooldown(msg.sender, lastDecryptionRequestTime)
    {
        if (!_isValidBatch(batchId)) revert BatchClosedOrNonExistent();
        _initIfNeeded(isProtocolSolvent[batchId]); // Ensure the ebool is initialized

        // 1. Prepare Ciphertexts
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = isProtocolSolvent[batchId].toBytes32();

        // 2. Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        // 5a. Replay Guard
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }

        // 5b. State Verification
        // Rebuild cts array in the exact same order as in requestSolvencyDecryption
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = isProtocolSolvent[decryptionContexts[requestId].batchId].toBytes32();
        bytes32 currentHash = _hashCiphertexts(cts);

        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        // 5c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // 5d. Decode & Finalize
        // cleartexts is expected to be abi.encodePacked(isSolventBool)
        // which is 1 byte. So, cleartexts.length should be 1.
        if (cleartexts.length != 1) revert InvalidProof(); // Or a more specific error

        bool isSolvent = cleartexts[0] != 0; // Decode the boolean

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, isSolvent);
    }

    function _calculateSolvency(uint256 batchId) internal {
        _initIfNeeded(totalEncryptedCollateral[batchId]);
        _initIfNeeded(totalEncryptedDebt[batchId]);
        ebool internalIsSolvent = totalEncryptedCollateral[batchId].ge(totalEncryptedDebt[batchId]);
        isProtocolSolvent[batchId] = internalIsSolvent;
        emit SolvencyCalculated(batchId, internalIsSolvent.toBytes32());
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 val) internal pure {
        if (!val.isInitialized()) {
            revert NotInitialized();
        }
    }

    function _initIfNeeded(ebool val) internal pure {
        if (!val.isInitialized()) {
            revert NotInitialized();
        }
    }

    function _isValidBatch(uint256 batchId) internal view returns (bool) {
        // A batch is valid if it's the current open batch, or a closed batch that has been processed.
        // For simplicity, we assume any batchId <= currentBatchId is potentially valid,
        // and specific operations will check if it's open or closed as needed.
        return batchId > 0 && batchId <= currentBatchId;
    }
}