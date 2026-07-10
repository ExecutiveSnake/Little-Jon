// Minimal ABI fragment for AnalysisCredits — only what the metering service needs.
// Keep in sync with contracts/src/AnalysisCredits.sol.
export const ANALYSIS_CREDITS_ABI = [
  "event Deposit(address indexed user, uint256 usdeAmount, uint256 creditsMinted, uint256 costPerCall, uint256 marginBps)",
  "event Debit(address indexed user, address indexed relayer, uint256 calls, uint256 creditsBurned)",
  "event RateUpdated(uint256 costPerCall, uint256 marginBps)",
  "function credits(address user) view returns (uint256)",
  "function debitCredit(address user, uint256 calls)",
] as const;
