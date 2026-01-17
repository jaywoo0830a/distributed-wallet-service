// English comments only in code
import crypto from "crypto";

/**
 * WalletAdapter must be implemented by your wallet integration.
 * Keep it deterministic and idempotent where possible.
 */
export class WalletAdapter {
  /**
   * Provision an address for a deposit intent.
   * @returns {Promise<{ address: string }>} 
   */
  async provisionDepositAddress({ depositIntentId }) {
    // Stub behavior
    return { address: "T" + depositIntentId.replace(/[^a-z0-9]/gi, "").slice(0, 24) };
  }

  /**
   * Observe deposits for a given address.
   * @returns {Promise<{ received_amount: string, current_confirmations: number }>} 
   */
  async observeDeposit({ minConfirmations }) {
    // Stub behavior: pretend nothing arrived yet
    return { received_amount: "0", current_confirmations: Math.max(0, Number(minConfirmations || 0)) };
  }

  /**
   * Finalize a deposit (credit internal ledger, etc).
   * Must be safe for retries.
   * @returns {Promise<{ capture_id: string, captured_at: string }>} 
   */
  async captureDeposit({ depositIntentId }) {
    return { capture_id: "cap_" + depositIntentId, captured_at: new Date().toISOString() };
  }

  /**
   * Reserve user funds for withdrawal.
   * Must be atomic on your side; throw if insufficient.
   */
  async reserveWithdrawal() {
    return { ok: true };
  }

  /**
   * Send withdrawal (broadcast tx).
   * Must be safe for retries.
   * @returns {Promise<{ txid: string, sent_at: string }>} 
   */
  async sendWithdrawal({ withdrawalIntentId }) {
    return { txid: "0x" + crypto.randomBytes(16).toString("hex"), sent_at: new Date().toISOString() };
  }

  /**
   * Confirm withdrawal (optional).
   * @returns {Promise<{ confirmed: boolean }>} 
   */
  async confirmWithdrawal() {
    return { confirmed: false };
  }
}
