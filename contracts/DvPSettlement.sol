// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SecurityToken} from "./SecurityToken.sol";

/// @title DvPSettlement
/// @notice Atomic delivery-versus-payment: the asset leg and the cash leg settle in one transaction
///         or not at all, removing principal risk. Failed attempts do not revert; they are recorded
///         on-chain with a reason code so operations can see and resolve settlement fails.
contract DvPSettlement is ReentrancyGuard {
    enum Status {
        None,
        Pending,
        Settled,
        Cancelled,
        Expired
    }

    struct Instruction {
        address seller;
        address buyer;
        SecurityToken asset;
        uint256 assetAmount;
        SecurityToken cash;
        uint256 cashAmount;
        uint64 deadline;
        bool sellerAffirmed;
        bool buyerAffirmed;
        Status status;
        uint32 failedAttempts;
    }

    uint8 public constant REASON_NONE = 0;
    uint8 public constant REASON_NOT_AFFIRMED = 1;
    uint8 public constant REASON_SELLER_INSUFFICIENT_ASSET = 2;
    uint8 public constant REASON_ASSET_NOT_COMPLIANT = 3;
    uint8 public constant REASON_ASSET_ALLOWANCE_MISSING = 4;
    uint8 public constant REASON_BUYER_INSUFFICIENT_CASH = 5;
    uint8 public constant REASON_CASH_NOT_COMPLIANT = 6;
    uint8 public constant REASON_CASH_ALLOWANCE_MISSING = 7;

    uint256 public nextId = 1;
    mapping(uint256 => Instruction) public instructions;

    event InstructionCreated(
        uint256 indexed id,
        address indexed seller,
        address indexed buyer,
        address asset,
        uint256 assetAmount,
        address cash,
        uint256 cashAmount,
        uint64 deadline
    );
    event Affirmed(uint256 indexed id, address indexed party);
    event Settled(uint256 indexed id);
    event SettlementFailed(uint256 indexed id, uint8 reason);
    event Cancelled(uint256 indexed id);
    event Expired(uint256 indexed id);

    error NotAParty();
    error NotPending();
    error InvalidInstruction();
    error AlreadyFullyAffirmed();

    function createInstruction(
        address seller,
        address buyer,
        SecurityToken asset,
        uint256 assetAmount,
        SecurityToken cash,
        uint256 cashAmount,
        uint64 deadline
    ) external returns (uint256 id) {
        if (msg.sender != seller && msg.sender != buyer) revert NotAParty();
        if (seller == buyer || assetAmount == 0 || cashAmount == 0 || deadline <= block.timestamp) {
            revert InvalidInstruction();
        }
        id = nextId++;
        Instruction storage ins = instructions[id];
        ins.seller = seller;
        ins.buyer = buyer;
        ins.asset = asset;
        ins.assetAmount = assetAmount;
        ins.cash = cash;
        ins.cashAmount = cashAmount;
        ins.deadline = deadline;
        ins.status = Status.Pending;
        emit InstructionCreated(id, seller, buyer, address(asset), assetAmount, address(cash), cashAmount, deadline);
        _affirm(id, ins);
    }

    function affirm(uint256 id) external {
        Instruction storage ins = instructions[id];
        if (ins.status != Status.Pending) revert NotPending();
        _affirm(id, ins);
    }

    /// @notice Either party may cancel until both sides have affirmed.
    function cancel(uint256 id) external {
        Instruction storage ins = instructions[id];
        if (ins.status != Status.Pending) revert NotPending();
        if (msg.sender != ins.seller && msg.sender != ins.buyer) revert NotAParty();
        if (ins.sellerAffirmed && ins.buyerAffirmed) revert AlreadyFullyAffirmed();
        ins.status = Status.Cancelled;
        emit Cancelled(id);
    }

    /// @notice Attempt settlement. Returns false (without reverting) if a precondition fails.
    function settle(uint256 id) external nonReentrant returns (bool) {
        Instruction storage ins = instructions[id];
        if (ins.status != Status.Pending) revert NotPending();

        if (block.timestamp > ins.deadline) {
            ins.status = Status.Expired;
            emit Expired(id);
            return false;
        }

        uint8 reason = _check(ins);
        if (reason != REASON_NONE) {
            ins.failedAttempts += 1;
            emit SettlementFailed(id, reason);
            return false;
        }

        ins.status = Status.Settled;
        require(ins.asset.transferFrom(ins.seller, ins.buyer, ins.assetAmount), "asset leg failed");
        require(ins.cash.transferFrom(ins.buyer, ins.seller, ins.cashAmount), "cash leg failed");
        emit Settled(id);
        return true;
    }

    /// @notice Dry-run of settle(): the reason code settlement would fail with right now, or 0.
    function checkSettlement(uint256 id) external view returns (uint8) {
        Instruction storage ins = instructions[id];
        if (ins.status != Status.Pending) revert NotPending();
        return _check(ins);
    }

    function _affirm(uint256 id, Instruction storage ins) private {
        if (msg.sender == ins.seller) {
            ins.sellerAffirmed = true;
        } else if (msg.sender == ins.buyer) {
            ins.buyerAffirmed = true;
        } else {
            revert NotAParty();
        }
        emit Affirmed(id, msg.sender);
    }

    function _check(Instruction storage ins) private view returns (uint8) {
        if (!ins.sellerAffirmed || !ins.buyerAffirmed) return REASON_NOT_AFFIRMED;

        uint8 assetCode = ins.asset.canTransfer(ins.seller, ins.buyer, ins.assetAmount);
        if (assetCode == ins.asset.CODE_INSUFFICIENT_BALANCE()) return REASON_SELLER_INSUFFICIENT_ASSET;
        if (assetCode != 0) return REASON_ASSET_NOT_COMPLIANT;
        if (ins.asset.allowance(ins.seller, address(this)) < ins.assetAmount) return REASON_ASSET_ALLOWANCE_MISSING;

        uint8 cashCode = ins.cash.canTransfer(ins.buyer, ins.seller, ins.cashAmount);
        if (cashCode == ins.cash.CODE_INSUFFICIENT_BALANCE()) return REASON_BUYER_INSUFFICIENT_CASH;
        if (cashCode != 0) return REASON_CASH_NOT_COMPLIANT;
        if (ins.cash.allowance(ins.buyer, address(this)) < ins.cashAmount) return REASON_CASH_ALLOWANCE_MISSING;

        return REASON_NONE;
    }
}
