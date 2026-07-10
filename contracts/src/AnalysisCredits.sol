// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AnalysisCredits
/// @notice Prepaid, non-transferable, illiquid credit system for an AI trading-analysis
///         service on Robinhood Chain. Users deposit a settlement token (e.g. USDe) and
///         receive an internal credit balance that can only be consumed by calling the
///         analysis service (via a trusted backend/relayer) — it is never transferable,
///         redeemable for the underlying token, or tradable. This is intentionally NOT
///         an ERC-20: there is no `transfer`, `approve`, or `transferFrom`, so credits
///         cannot move between accounts or acquire secondary-market liquidity.
/// @dev Deposits are priced using a snapshot of `costPerCall` and `marginBps` taken at
///      deposit time, so admin-driven rate changes never retroactively affect credits a
///      user already purchased. Rate changes are queued through a time-locked update
///      so users can see pricing changes coming before they take effect.
contract AnalysisCredits is AccessControl, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    /// @notice Role granted to the off-chain metering/relayer service allowed to burn
    ///         credits once an analysis call has been successfully delivered.
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice The ERC-20 settlement token accepted for deposits (e.g. USDe).
    IERC20 public immutable settlementToken;

    /// @notice Number of decimals `settlementToken` uses, cached at construction for
    ///         conversion-rate math.
    uint8 public immutable settlementDecimals;

    /// @notice Non-transferable credit balance per user. Intentionally public and a
    ///         plain mapping (not an ERC-20) — there is no transfer/approve surface.
    mapping(address => uint256) public credits;

    /// @notice Cost of a single analysis call, denominated in whole credits worth of
    ///         `settlementToken` base units (before margin), currently in effect.
    uint256 public costPerCall;

    /// @notice Margin applied on top of `costPerCall`, in basis points (1/100th of a
    ///         percent), currently in effect. E.g. 500 = 5%.
    uint256 public marginBps;

    /// @notice Minimum delay, in seconds, between queuing a rate change and it taking
    ///         effect. Gives depositors advance visibility into upcoming pricing.
    uint256 public rateUpdateDelay;

    /// @notice Timestamp at which a pending rate change becomes active. Zero if there is
    ///         no pending change.
    uint256 public pendingRateEffectiveAt;

    /// @notice Pending `costPerCall` value queued for activation at
    ///         `pendingRateEffectiveAt`.
    uint256 public pendingCostPerCall;

    /// @notice Pending `marginBps` value queued for activation at
    ///         `pendingRateEffectiveAt`.
    uint256 public pendingMarginBps;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted when a user deposits `settlementToken` and is credited.
    /// @param user The depositor.
    /// @param usdeAmount The amount of `settlementToken` deposited (base units).
    /// @param creditsMinted The number of credits minted to `user`.
    /// @param costPerCall The `costPerCall` snapshot used for this deposit's pricing.
    /// @param marginBps The `marginBps` snapshot used for this deposit's pricing.
    event Deposit(
        address indexed user,
        uint256 usdeAmount,
        uint256 creditsMinted,
        uint256 costPerCall,
        uint256 marginBps
    );

    /// @notice Emitted when credits are burned for a completed analysis call.
    /// @param user The account whose credits were debited.
    /// @param relayer The relayer that performed the debit.
    /// @param calls Number of analysis calls being settled.
    /// @param creditsBurned Number of credits burned.
    event Debit(address indexed user, address indexed relayer, uint256 calls, uint256 creditsBurned);

    /// @notice Emitted when the owner queues a new conversion rate.
    /// @param newCostPerCall The queued `costPerCall`.
    /// @param newMarginBps The queued `marginBps`.
    /// @param effectiveAt The timestamp at which the new rate becomes active.
    event RateUpdateQueued(uint256 newCostPerCall, uint256 newMarginBps, uint256 effectiveAt);

    /// @notice Emitted once a queued rate change has taken effect (lazily, on the first
    ///         interaction after `effectiveAt` has passed, or explicitly via
    ///         `activatePendingRate`).
    /// @param costPerCall The now-active `costPerCall`.
    /// @param marginBps The now-active `marginBps`.
    event RateUpdated(uint256 costPerCall, uint256 marginBps);

    /// @notice Emitted when the owner sweeps accumulated `settlementToken` out of the
    ///         contract's treasury.
    event TreasuryWithdraw(address indexed to, uint256 amount);

    /// @notice Emitted when the owner changes the rate-update time-lock delay.
    event RateUpdateDelaySet(uint256 newDelay);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientCredits(address user, uint256 available, uint256 required);
    error NoPendingRateUpdate();
    error RateNotYetEffective(uint256 effectiveAt);

    /// @param _settlementToken The ERC-20 token accepted for deposits (e.g. USDe).
    /// @param _costPerCall Initial cost per analysis call, in `_settlementToken` base units.
    /// @param _marginBps Initial margin, in basis points.
    /// @param _rateUpdateDelay Initial time-lock delay (seconds) for future rate changes.
    /// @param _admin Address granted `DEFAULT_ADMIN_ROLE` and ownership.
    constructor(
        IERC20 _settlementToken,
        uint256 _costPerCall,
        uint256 _marginBps,
        uint256 _rateUpdateDelay,
        address _admin
    ) Ownable(_admin) {
        if (address(_settlementToken) == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();
        if (_costPerCall == 0) revert ZeroAmount();

        settlementToken = _settlementToken;
        settlementDecimals = IERC20Metadata(address(_settlementToken)).decimals();

        costPerCall = _costPerCall;
        marginBps = _marginBps;
        rateUpdateDelay = _rateUpdateDelay;

        // `_admin` starts out as both the Ownable owner (gates treasury/rate/relayer-role
        // management here) and the AccessControl DEFAULT_ADMIN_ROLE holder (gates the
        // inherited grantRole/revokeRole for RELAYER_ROLE). If ownership is transferred
        // later, also migrate DEFAULT_ADMIN_ROLE via grantRole/revokeRole so the two
        // authority tracks don't drift apart.
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ---------------------------------------------------------------------
    // User-facing
    // ---------------------------------------------------------------------

    /// @notice Deposit `amount` of `settlementToken` and receive non-transferable
    ///         analysis credits priced at the currently active conversion rate.
    /// @dev Applies any pending rate update whose time-lock has elapsed before pricing
    ///      this deposit, so users always get the freshest rate that has actually
    ///      become effective. Credits are computed as:
    ///      `credits = amount / (costPerCall * (1 + marginBps / 10_000))`, floored.
    /// @param amount Amount of `settlementToken` to deposit, in base units.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        _applyPendingRateIfDue();

        uint256 minted = _quoteCredits(amount);

        credits[msg.sender] += minted;

        settlementToken.safeTransferFrom(msg.sender, address(this), amount);

        emit Deposit(msg.sender, amount, minted, costPerCall, marginBps);
    }

    /// @notice Preview how many credits `amount` of `settlementToken` would mint at the
    ///         currently active rate (does not account for a not-yet-due pending update).
    function quoteCredits(uint256 amount) external view returns (uint256) {
        return _quoteCredits(amount);
    }

    // ---------------------------------------------------------------------
    // Relayer (backend metering service)
    // ---------------------------------------------------------------------

    /// @notice Burn `calls` worth of credits from `user` once the off-chain analysis
    ///         service has successfully delivered `calls` analyses. Restricted to
    ///         accounts holding `RELAYER_ROLE`.
    /// @dev The relayer is expected to only invoke this after a successful delivery, so
    ///      a failed model call never results in a debit (see off-chain metering
    ///      service for the idempotency/retry contract this depends on).
    /// @param user The account whose credits are being consumed.
    /// @param calls Number of analysis calls being settled (1 call == 1 credit).
    function debitCredit(address user, uint256 calls) external onlyRole(RELAYER_ROLE) {
        if (user == address(0)) revert ZeroAddress();
        if (calls == 0) revert ZeroAmount();

        uint256 balance = credits[user];
        if (balance < calls) revert InsufficientCredits(user, balance, calls);

        credits[user] = balance - calls;

        emit Debit(user, msg.sender, calls, calls);
    }

    // ---------------------------------------------------------------------
    // Admin — rate management (time-locked)
    // ---------------------------------------------------------------------

    /// @notice Queue a new conversion rate. It becomes active only after
    ///         `rateUpdateDelay` seconds have passed, giving depositors advance notice.
    /// @dev Overwrites any previously queued (not-yet-effective) pending rate.
    /// @param newCostPerCall New cost per call, in `settlementToken` base units.
    /// @param newMarginBps New margin, in basis points.
    function queueRateUpdate(uint256 newCostPerCall, uint256 newMarginBps) external onlyOwner {
        if (newCostPerCall == 0) revert ZeroAmount();

        _applyPendingRateIfDue();

        uint256 effectiveAt = block.timestamp + rateUpdateDelay;
        pendingCostPerCall = newCostPerCall;
        pendingMarginBps = newMarginBps;
        pendingRateEffectiveAt = effectiveAt;

        emit RateUpdateQueued(newCostPerCall, newMarginBps, effectiveAt);
    }

    /// @notice Explicitly activate a queued rate update once its time-lock has elapsed.
    ///         Anyone may call this; it is also applied lazily on `deposit` and
    ///         `queueRateUpdate`. Provided so the new rate can be made visible on-chain
    ///         (via the `RateUpdated` event) without waiting for the next deposit.
    function activatePendingRate() external {
        if (pendingRateEffectiveAt == 0) revert NoPendingRateUpdate();
        if (block.timestamp < pendingRateEffectiveAt) revert RateNotYetEffective(pendingRateEffectiveAt);

        _applyPendingRateIfDue();
    }

    /// @notice Update the time-lock delay applied to future rate changes.
    /// @param newDelay New delay, in seconds.
    function setRateUpdateDelay(uint256 newDelay) external onlyOwner {
        rateUpdateDelay = newDelay;
        emit RateUpdateDelaySet(newDelay);
    }

    // ---------------------------------------------------------------------
    // Admin — access control
    // ---------------------------------------------------------------------

    /// @notice Grant `RELAYER_ROLE` to the off-chain metering/relayer service address.
    function grantRelayer(address relayer) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        _grantRole(RELAYER_ROLE, relayer);
    }

    /// @notice Revoke `RELAYER_ROLE` from an address, e.g. during key rotation.
    function revokeRelayer(address relayer) external onlyOwner {
        _revokeRole(RELAYER_ROLE, relayer);
    }

    // ---------------------------------------------------------------------
    // Admin — treasury
    // ---------------------------------------------------------------------

    /// @notice Withdraw accumulated `settlementToken` from the contract to `to`. Owner
    ///         only. Credits are never redeemable for the underlying token by users —
    ///         this is strictly an operator sweep of deposited funds.
    /// @param to Recipient of the withdrawn funds.
    /// @param amount Amount of `settlementToken` to withdraw, in base units.
    function withdrawTreasury(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        settlementToken.safeTransfer(to, amount);

        emit TreasuryWithdraw(to, amount);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _quoteCredits(uint256 amount) internal view returns (uint256) {
        // credits = amount / (costPerCall * (1 + marginBps / 10_000))
        //         = amount * BPS_DENOMINATOR / (costPerCall * (BPS_DENOMINATOR + marginBps))
        // Computed as a single flooring division so partial-credit dust is never
        // minted (rounds in the protocol's favor).
        return (amount * BPS_DENOMINATOR) / (costPerCall * (BPS_DENOMINATOR + marginBps));
    }

    function _applyPendingRateIfDue() internal {
        if (pendingRateEffectiveAt != 0 && block.timestamp >= pendingRateEffectiveAt) {
            costPerCall = pendingCostPerCall;
            marginBps = pendingMarginBps;
            pendingRateEffectiveAt = 0;
            pendingCostPerCall = 0;
            pendingMarginBps = 0;
            emit RateUpdated(costPerCall, marginBps);
        }
    }
}
