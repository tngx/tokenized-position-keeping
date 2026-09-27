// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";

/// @title SecurityToken
/// @notice Permissioned ERC-20 for tokenized financial instruments (simplified ERC-3643 model).
///         Every holder must be verified in the IdentityRegistry; an agent can freeze wallets or
///         pause the instrument. Used for both securities (decimals 0) and tokenized cash.
contract SecurityToken is ERC20, AccessControl, Pausable {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    uint8 public constant CODE_OK = 0;
    uint8 public constant CODE_PAUSED = 1;
    uint8 public constant CODE_SENDER_NOT_VERIFIED = 2;
    uint8 public constant CODE_RECIPIENT_NOT_VERIFIED = 3;
    uint8 public constant CODE_SENDER_FROZEN = 4;
    uint8 public constant CODE_RECIPIENT_FROZEN = 5;
    uint8 public constant CODE_INSUFFICIENT_BALANCE = 6;

    IdentityRegistry public immutable identityRegistry;
    string public isin;
    string public assetClass;
    uint8 private immutable _decimals;

    mapping(address => bool) public frozen;

    event Tokenized(address indexed to, uint256 amount, bytes32 indexed ref);
    event Detokenized(address indexed from, uint256 amount, bytes32 indexed ref);
    event WalletFrozen(address indexed wallet, bool frozen);

    error TransferNotCompliant(uint8 code);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        string memory isin_,
        string memory assetClass_,
        IdentityRegistry registry,
        address admin
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
        isin = isin_;
        assetClass = assetClass_;
        identityRegistry = registry;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
        _grantRole(AGENT_ROLE, admin);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint units on-chain. `ref` links the mint to an off-chain lock or issuance record.
    function tokenize(address to, uint256 amount, bytes32 ref) external onlyRole(ISSUER_ROLE) {
        _mint(to, amount);
        emit Tokenized(to, amount, ref);
    }

    /// @notice Burn units on-chain, e.g. when a holder moves a position back to the book-entry register.
    function detokenize(address from, uint256 amount, bytes32 ref) external onlyRole(ISSUER_ROLE) {
        _burn(from, amount);
        emit Detokenized(from, amount, ref);
    }

    function setFrozen(address wallet, bool isFrozen) external onlyRole(AGENT_ROLE) {
        frozen[wallet] = isFrozen;
        emit WalletFrozen(wallet, isFrozen);
    }

    function pause() external onlyRole(AGENT_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(AGENT_ROLE) {
        _unpause();
    }

    /// @notice Pre-trade compliance check without executing a transfer. Returns CODE_OK or a reason code.
    function canTransfer(address from, address to, uint256 amount) public view returns (uint8) {
        if (paused()) return CODE_PAUSED;
        if (!identityRegistry.isVerified(from)) return CODE_SENDER_NOT_VERIFIED;
        if (!identityRegistry.isVerified(to)) return CODE_RECIPIENT_NOT_VERIFIED;
        if (frozen[from]) return CODE_SENDER_FROZEN;
        if (frozen[to]) return CODE_RECIPIENT_FROZEN;
        if (balanceOf(from) < amount) return CODE_INSUFFICIENT_BALANCE;
        return CODE_OK;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (paused()) revert TransferNotCompliant(CODE_PAUSED);
        if (from != address(0)) {
            if (!identityRegistry.isVerified(from)) revert TransferNotCompliant(CODE_SENDER_NOT_VERIFIED);
            if (frozen[from]) revert TransferNotCompliant(CODE_SENDER_FROZEN);
        }
        if (to != address(0)) {
            if (!identityRegistry.isVerified(to)) revert TransferNotCompliant(CODE_RECIPIENT_NOT_VERIFIED);
            if (frozen[to]) revert TransferNotCompliant(CODE_RECIPIENT_FROZEN);
        }
        super._update(from, to, value);
    }
}
