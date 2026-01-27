import axios from "axios";
import Decimal from "decimal.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Bitcoin Wallet Adapter (RPC)
 */
export class BitcoinWalletAdapter {
  constructor(config) {
    this.rpcUrl = config.rpcUrl;
    this.rpcUser = config.rpcUser;
    this.rpcPass = config.rpcPass;
  }

  async _callRpc(method, params = []) {
    try {
      const response = await axios.post(
        this.rpcUrl,
        { jsonrpc: "1.0", id: "wallet-service", method, params },
        {
          auth: { username: this.rpcUser, password: this.rpcPass },
          headers: { "Content-Type": "application/json" },
          timeout: 10000,
        },
      );
      if (response.data.error) throw new Error(response.data.error.message);
      return response.data.result;
    } catch (error) {
      console.error(`[BTC-RPC] ${method} Error:`, error.message);
      throw new Error(`Bitcoin RPC Failed: ${error.message}`);
    }
  }

  async createAddress() {
    return await this._callRpc("getnewaddress", ["", "bech32"]);
  }

  async sendBatch(withdrawals) {
    const outputs = {};
    for (const w of withdrawals) {
      outputs[w.to] = new Decimal(w.amount).toNumber();
    }
    return await this._callRpc("sendmany", ["", outputs, 1]);
  }

  async getBalance() {
    const total = await this._callRpc("getbalance", ["*", 0]);
    const spendable = await this._callRpc("getbalance", ["*", 1]);
    return {
      total: new Decimal(total).toFixed(8),
      spendable: new Decimal(confirmedTotal).toFixed(8),
      locked: new Decimal(total).minus(confirmedTotal).toFixed(8),
    };
  }
}

/**
 * Monero Wallet Adapter (RPC)
 */
export class MoneroWalletAdapter {
  constructor(config) {
    this.rpcUrl = config.rpcUrl;
  }

  async _callRpc(method, params = {}) {
    try {
      const response = await axios.post(
        this.rpcUrl,
        { jsonrpc: "2.0", id: "0", method, params },
        { headers: { "Content-Type": "application/json" }, timeout: 15000 },
      );
      if (response.data.error) throw new Error(response.data.error.message);
      return response.data.result;
    } catch (error) {
      console.error(`[XMR-RPC] ${method} Error:`, error.message);
      throw new Error(`Monero RPC Failed: ${error.message}`);
    }
  }

  async createAddress() {
    const res = await this._callRpc("create_address", { account_index: 0 });
    return res.address;
  }

  async sendBatch(withdrawals) {
    const destinations = withdrawals.map((w) => ({
      amount: new Decimal(w.amount).times(1e12).toDecimalPlaces(0).toNumber(),
      address: w.to,
    }));
    const res = await this._callRpc("transfer_split", {
      destinations,
      account_index: 0,
      priority: 2,
    });
    return res.tx_hash_list ? res.tx_hash_list.join(",") : res.tx_hash;
  }

  async getBalance() {
    const res = await this._callRpc("get_balance", { account_index: 0 });
    return {
      total: new Decimal(res.balance).div(1e12).toFixed(12),
      spendable: new Decimal(res.unlocked_balance).div(1e12).toFixed(12),
      locked: new Decimal(res.balance)
        .minus(res.unlocked_balance)
        .div(1e12)
        .toFixed(12),
    };
  }
}

/**
 * Mock Wallet Adapter for local development and testing
 * Simulates realistic blockchain responses without actual RPC calls
 */
export class MockWalletAdapter {
  constructor(asset) {
    this.asset = asset;
  }

  async createAddress() {
    // Generate realistic looking mock addresses based on asset
    if (this.asset === "BTC") {
      return `bcrt1qmock${uuidv4().replace(/-/g, "").substring(0, 32)}`;
    }
    return `4mock${uuidv4().replace(/-/g, "").substring(0, 90)}`;
  }

  async sendBatch(withdrawals) {
    console.log(
      `[MockAdapter-${this.asset}] Simulating batch transfer for ${withdrawals.length} destinations`,
    );
    return `tx_mock_${this.asset.toLowerCase()}_${uuidv4().replace(/-/g, "")}`;
  }

  async getBalance() {
    // Return static but plausible balance data
    const mockBalance =
      this.asset === "BTC" ? "1.23456789" : "100.123456789012";
    return {
      total: mockBalance,
      spendable: new Decimal(mockBalance)
        .times(0.9)
        .toFixed(this.asset === "BTC" ? 8 : 12),
      locked: new Decimal(mockBalance)
        .times(0.1)
        .toFixed(this.asset === "BTC" ? 8 : 12),
      lock_reason: "Mock pending deposit",
    };
  }
}

/**
 * Factory resolver for wallet adapters
 */
const getAdapterInstance = (asset) => {
  const isMockMode = process.env.WALLET_MODE === "mock";

  if (isMockMode) {
    console.log(`[AdapterFactory] Initializing MOCK adapter for ${asset}`);
    return new MockWalletAdapter(asset);
  }

  if (asset === "BTC") {
    return new BitcoinWalletAdapter({
      rpcUrl: process.env.BTC_RPC_URL,
      rpcUser: process.env.BTC_RPC_USER,
      rpcPass: process.env.BTC_RPC_PASS,
    });
  }

  if (asset === "XMR") {
    return new MoneroWalletAdapter({
      rpcUrl: process.env.XMR_RPC_URL,
    });
  }

  throw new Error(`Unsupported Asset: ${asset}`);
};

export const walletAdapter = {
  createAddress: (asset) => getAdapterInstance(asset).createAddress(),
  sendBatch: (withdrawals, asset) =>
    getAdapterInstance(asset).sendBatch(withdrawals),
  getBalance: (asset) => getAdapterInstance(asset).getBalance(),
};
