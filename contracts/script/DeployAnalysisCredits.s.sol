// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AnalysisCredits} from "../src/AnalysisCredits.sol";

/// @notice Deploys AnalysisCredits. Reads configuration from environment variables so
///         the same script works for Robinhood Chain testnet and mainnet.
///
/// Required env vars:
///   PRIVATE_KEY            - deployer key (becomes owner/admin unless ADMIN_ADDRESS set)
///   SETTLEMENT_TOKEN       - address of the deposit token (e.g. USDe) on the target chain
///   COST_PER_CALL          - initial cost per call, in settlement-token base units
///   MARGIN_BPS             - initial margin, in basis points
///   RATE_UPDATE_DELAY      - time-lock delay for rate changes, in seconds
///
/// Optional:
///   ADMIN_ADDRESS          - owner/admin address, defaults to the deployer
///   RELAYER_ADDRESS        - if set, granted RELAYER_ROLE immediately after deployment
///
/// Usage (testnet):
///   forge script script/DeployAnalysisCredits.s.sol:DeployAnalysisCredits \
///     --rpc-url robinhood_testnet --broadcast --verify -vvvv
contract DeployAnalysisCredits is Script {
    function run() external returns (AnalysisCredits deployed) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address settlementToken = vm.envAddress("SETTLEMENT_TOKEN");
        uint256 costPerCall = vm.envUint("COST_PER_CALL");
        uint256 marginBps = vm.envUint("MARGIN_BPS");
        uint256 rateUpdateDelay = vm.envUint("RATE_UPDATE_DELAY");
        address admin = vm.envOr("ADMIN_ADDRESS", deployer);
        address relayer = vm.envOr("RELAYER_ADDRESS", address(0));

        vm.startBroadcast(deployerKey);

        deployed = new AnalysisCredits(
            IERC20(settlementToken), costPerCall, marginBps, rateUpdateDelay, admin
        );

        if (relayer != address(0)) {
            // Only works when deployer == admin (grantRelayer is onlyOwner); if ADMIN_ADDRESS
            // differs from the deployer, grant the relayer role separately from the admin key.
            if (admin == deployer) {
                deployed.grantRelayer(relayer);
            } else {
                console.log("Skipping grantRelayer: ADMIN_ADDRESS != deployer.");
                console.log("Run grantRelayer from the admin key separately.");
            }
        }

        vm.stopBroadcast();

        console.log("AnalysisCredits deployed at:", address(deployed));
        console.log("Settlement token:", settlementToken);
        console.log("Admin/owner:", admin);
        console.log("costPerCall:", costPerCall);
        console.log("marginBps:", marginBps);
        console.log("rateUpdateDelay (s):", rateUpdateDelay);
    }
}
