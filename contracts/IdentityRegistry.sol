// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title IdentityRegistry
/// @notice On-chain allowlist of KYC-verified investor wallets, shared by all permissioned tokens.
contract IdentityRegistry is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    struct Investor {
        bool verified;
        uint16 country; // ISO 3166-1 numeric, e.g. 276 = Germany
    }

    mapping(address => Investor) private _investors;

    event InvestorRegistered(address indexed wallet, uint16 country);
    event InvestorRemoved(address indexed wallet);

    error ZeroAddress();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
    }

    function registerInvestor(address wallet, uint16 country) external onlyRole(REGISTRAR_ROLE) {
        if (wallet == address(0)) revert ZeroAddress();
        _investors[wallet] = Investor(true, country);
        emit InvestorRegistered(wallet, country);
    }

    function removeInvestor(address wallet) external onlyRole(REGISTRAR_ROLE) {
        delete _investors[wallet];
        emit InvestorRemoved(wallet);
    }

    function isVerified(address wallet) external view returns (bool) {
        return _investors[wallet].verified;
    }

    function countryOf(address wallet) external view returns (uint16) {
        return _investors[wallet].country;
    }
}
