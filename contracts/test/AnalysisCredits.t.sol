// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AnalysisCredits} from "../src/AnalysisCredits.sol";
import {MockUSDe} from "./mocks/MockUSDe.sol";

contract AnalysisCreditsTest is Test {
    AnalysisCredits internal creditsContract;
    MockUSDe internal usde;

    address internal admin = makeAddr("admin");
    address internal relayer = makeAddr("relayer");
    address internal user = makeAddr("user");
    address internal other = makeAddr("other");
    address internal treasuryRecipient = makeAddr("treasuryRecipient");

    uint256 internal constant COST_PER_CALL = 1e18; // 1 USDe per call, before margin
    uint256 internal constant MARGIN_BPS = 1_000; // 10%
    uint256 internal constant RATE_DELAY = 1 days;

    function setUp() public {
        usde = new MockUSDe();

        vm.prank(admin);
        creditsContract =
            new AnalysisCredits(usde, COST_PER_CALL, MARGIN_BPS, RATE_DELAY, admin);

        vm.prank(admin);
        creditsContract.grantRelayer(relayer);

        usde.mint(user, 1_000_000e18);
        usde.mint(other, 1_000_000e18);

        vm.prank(user);
        usde.approve(address(creditsContract), type(uint256).max);
        vm.prank(other);
        usde.approve(address(creditsContract), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Deposit
    // ---------------------------------------------------------------------

    function test_Deposit_MintsExpectedCredits() public {
        uint256 depositAmount = 110e18; // effective price = 1.1 USDe/call -> 100 credits

        vm.expectEmit(true, false, false, true, address(creditsContract));
        emit AnalysisCredits.Deposit(user, depositAmount, 100, COST_PER_CALL, MARGIN_BPS);

        vm.prank(user);
        creditsContract.deposit(depositAmount);

        assertEq(creditsContract.credits(user), 100);
        assertEq(usde.balanceOf(address(creditsContract)), depositAmount);
    }

    function test_Deposit_RevertsOnZeroAmount() public {
        vm.prank(user);
        vm.expectRevert(AnalysisCredits.ZeroAmount.selector);
        creditsContract.deposit(0);
    }

    function test_Deposit_RevertsWithoutApproval() public {
        address noApproval = makeAddr("noApproval");
        usde.mint(noApproval, 100e18);

        vm.prank(noApproval);
        vm.expectRevert();
        creditsContract.deposit(100e18);
    }

    function test_Deposit_AccumulatesAcrossMultipleDeposits() public {
        vm.startPrank(user);
        creditsContract.deposit(110e18); // 100 credits
        creditsContract.deposit(55e18); // 50 credits
        vm.stopPrank();

        assertEq(creditsContract.credits(user), 150);
    }

    function test_Deposit_FloorsPartialCredit() public {
        // effective price = 1.1 USDe/call; 100.5e18 buys 91 whole credits (91.36..),
        // dust is not minted.
        vm.prank(user);
        creditsContract.deposit(100.5e18);

        assertEq(creditsContract.credits(user), 91);
    }

    function test_QuoteCredits_MatchesDepositAccounting() public view {
        assertEq(creditsContract.quoteCredits(110e18), 100);
    }

    // ---------------------------------------------------------------------
    // Debit
    // ---------------------------------------------------------------------

    function test_DebitCredit_RelayerBurnsCredits() public {
        vm.prank(user);
        creditsContract.deposit(110e18); // 100 credits

        vm.expectEmit(true, true, false, true, address(creditsContract));
        emit AnalysisCredits.Debit(user, relayer, 3, 3);

        vm.prank(relayer);
        creditsContract.debitCredit(user, 3);

        assertEq(creditsContract.credits(user), 97);
    }

    function test_DebitCredit_RevertsForNonRelayer() public {
        vm.prank(user);
        creditsContract.deposit(110e18);

        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                other,
                creditsContract.RELAYER_ROLE()
            )
        );
        creditsContract.debitCredit(user, 1);
    }

    function test_DebitCredit_RevertsWhenInsufficientBalance() public {
        vm.prank(user);
        creditsContract.deposit(110e18); // 100 credits

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                AnalysisCredits.InsufficientCredits.selector, user, 100, 101
            )
        );
        creditsContract.debitCredit(user, 101);
    }

    function test_DebitCredit_RevertsOnZeroCalls() public {
        vm.prank(relayer);
        vm.expectRevert(AnalysisCredits.ZeroAmount.selector);
        creditsContract.debitCredit(user, 0);
    }

    function test_RevokeRelayer_RemovesAccess() public {
        vm.prank(admin);
        creditsContract.revokeRelayer(relayer);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                relayer,
                creditsContract.RELAYER_ROLE()
            )
        );
        creditsContract.debitCredit(user, 1);
    }

    // ---------------------------------------------------------------------
    // Rate changes / time-lock
    // ---------------------------------------------------------------------

    function test_QueueRateUpdate_DoesNotAffectCurrentRateImmediately() public {
        vm.prank(admin);
        creditsContract.queueRateUpdate(2e18, 0);

        // Old rate still active until the delay elapses.
        assertEq(creditsContract.costPerCall(), COST_PER_CALL);
        assertEq(creditsContract.marginBps(), MARGIN_BPS);

        vm.prank(user);
        creditsContract.deposit(110e18);
        assertEq(creditsContract.credits(user), 100);
    }

    function test_RateUpdate_AppliesOnlyToFutureDeposits() public {
        vm.prank(user);
        creditsContract.deposit(110e18); // priced at old rate -> 100 credits

        vm.prank(admin);
        creditsContract.queueRateUpdate(2e18, 0); // new rate: 2 USDe/call, no margin

        vm.warp(block.timestamp + RATE_DELAY + 1);

        vm.prank(other);
        creditsContract.deposit(200e18); // priced at new rate -> 100 credits

        // First depositor's already-minted credits are untouched by the rate change.
        assertEq(creditsContract.credits(user), 100);
        assertEq(creditsContract.credits(other), 100);
        assertEq(creditsContract.costPerCall(), 2e18);
        assertEq(creditsContract.marginBps(), 0);
    }

    function test_ActivatePendingRate_RevertsBeforeDelay() public {
        vm.prank(admin);
        creditsContract.queueRateUpdate(2e18, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                AnalysisCredits.RateNotYetEffective.selector,
                block.timestamp + RATE_DELAY
            )
        );
        creditsContract.activatePendingRate();
    }

    function test_ActivatePendingRate_RevertsWithNoPendingUpdate() public {
        vm.expectRevert(AnalysisCredits.NoPendingRateUpdate.selector);
        creditsContract.activatePendingRate();
    }

    function test_ActivatePendingRate_EmitsRateUpdated() public {
        vm.prank(admin);
        creditsContract.queueRateUpdate(2e18, 500);

        vm.warp(block.timestamp + RATE_DELAY + 1);

        vm.expectEmit(false, false, false, true, address(creditsContract));
        emit AnalysisCredits.RateUpdated(2e18, 500);
        creditsContract.activatePendingRate();

        assertEq(creditsContract.costPerCall(), 2e18);
        assertEq(creditsContract.marginBps(), 500);
    }

    function test_QueueRateUpdate_RevertsForNonOwner() public {
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other)
        );
        creditsContract.queueRateUpdate(2e18, 0);
    }

    function test_QueueRateUpdate_OverwritesPreviousPendingUpdate() public {
        vm.startPrank(admin);
        creditsContract.queueRateUpdate(2e18, 0);
        creditsContract.queueRateUpdate(3e18, 200);
        vm.stopPrank();

        vm.warp(block.timestamp + RATE_DELAY + 1);
        creditsContract.activatePendingRate();

        assertEq(creditsContract.costPerCall(), 3e18);
        assertEq(creditsContract.marginBps(), 200);
    }

    function test_SetRateUpdateDelay_OnlyOwner() public {
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other)
        );
        creditsContract.setRateUpdateDelay(7 days);

        vm.prank(admin);
        creditsContract.setRateUpdateDelay(7 days);
        assertEq(creditsContract.rateUpdateDelay(), 7 days);
    }

    // ---------------------------------------------------------------------
    // Treasury
    // ---------------------------------------------------------------------

    function test_WithdrawTreasury_OwnerCanPullFunds() public {
        vm.prank(user);
        creditsContract.deposit(110e18);

        vm.prank(admin);
        creditsContract.withdrawTreasury(treasuryRecipient, 110e18);

        assertEq(usde.balanceOf(treasuryRecipient), 110e18);
        assertEq(usde.balanceOf(address(creditsContract)), 0);
    }

    function test_WithdrawTreasury_RevertsForNonOwner() public {
        vm.prank(user);
        creditsContract.deposit(110e18);

        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other)
        );
        creditsContract.withdrawTreasury(treasuryRecipient, 1e18);
    }

    function test_WithdrawTreasury_RevertsOnInsufficientBalance() public {
        vm.prank(admin);
        vm.expectRevert();
        creditsContract.withdrawTreasury(treasuryRecipient, 1e18);
    }

    function test_WithdrawTreasury_DoesNotAffectUserCreditBalances() public {
        vm.prank(user);
        creditsContract.deposit(110e18); // 100 credits

        vm.prank(admin);
        creditsContract.withdrawTreasury(treasuryRecipient, 110e18);

        // Credits are an internal ledger entry, not backed 1:1 by contract balance —
        // withdrawing the treasury must never affect the (illiquid, non-transferable)
        // credit balance itself.
        assertEq(creditsContract.credits(user), 100);
    }

    // ---------------------------------------------------------------------
    // Non-transferability / no ERC-20 surface
    // ---------------------------------------------------------------------

    function test_NoTransferFunctionExists() public {
        // Compile-time guarantee: AnalysisCredits has no transfer/approve/transferFrom
        // selectors at all. This test documents the invariant via a low-level call that
        // must revert with the receive/fallback path (function does not exist).
        (bool success,) = address(creditsContract).call(
            abi.encodeWithSignature("transfer(address,uint256)", other, 1)
        );
        assertFalse(success);
    }

    // ---------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------

    function testFuzz_Deposit_CreditsNeverExceedQuote(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000e18);

        vm.prank(user);
        creditsContract.deposit(amount);

        uint256 expected = (amount * 10_000) / (COST_PER_CALL * (10_000 + MARGIN_BPS));
        assertEq(creditsContract.credits(user), expected);
    }

    function testFuzz_DebitCredit_NeverUnderflows(uint256 depositAmount, uint256 debitCalls)
        public
    {
        depositAmount = bound(depositAmount, 1.1e18, 1_000_000e18);

        vm.prank(user);
        creditsContract.deposit(depositAmount);

        uint256 balance = creditsContract.credits(user);
        debitCalls = bound(debitCalls, 0, balance);

        if (debitCalls == 0) {
            vm.prank(relayer);
            vm.expectRevert(AnalysisCredits.ZeroAmount.selector);
            creditsContract.debitCredit(user, debitCalls);
        } else {
            vm.prank(relayer);
            creditsContract.debitCredit(user, debitCalls);
            assertEq(creditsContract.credits(user), balance - debitCalls);
        }
    }
}
