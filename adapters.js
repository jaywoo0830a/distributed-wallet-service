import axios from "axios";
import Decimal from "decimal.js";
import { v4 as uuidv4 } from "uuid";

// --- Wallet Adapter Interface & Implementations ---

/**
 * Interface for Wallet Adapters
 *
 * createAddress(asset, network): Promise<string>
 * sendBatch(withdrawals, asset, network): Promise<string> (returns txid)
 * getBalance(asset, network): Promise<{ total: string, spendable: string, locked: string, lock_reason: string }>
 */

/**
 * Bitcoin Wallet Adapter
 * Ref: https://developer.bitcoin.org/reference/rpc/
 */
export class BitcoinWalletAdapter {
  constructor(config) {
    this.rpcUrl = config.rpcUrl; // e.g., http://127.0.0.1:8332
    this.rpcUser = config.rpcUser;
    this.rpcPass = config.rpcPass;
  }

  async _callRpc(method, params = []) {
    try {
      const response = await axios.post(
        this.rpcUrl,
        {
          jsonrpc: "1.0",
          id: "wallet-service",
          method,
          params,
        },
        {
          auth: {
            username: this.rpcUser,
            password: this.rpcPass,
          },
          headers: { Connection: "keep-alive" },
        },
      );

      if (response.data.error) {
        throw new Error(
          `RPC Error ${response.data.error.code}: ${response.data.error.message}`,
        );
      }
      return response.data.result;
    } catch (error) {
      const msg = error.response?.data?.error?.message || error.message;
      console.error(`Bitcoin RPC Error [${method}]:`, msg);
      throw new Error(`Bitcoin RPC Failed: ${msg}`);
    }
  }

  async createAddress(asset, network) {
    // getnewaddress [label] [address_type]
    const address = await this._callRpc("getnewaddress", [
      "wallet-service-deposit",
      "bech32",
    ]);
    return address;
  }

  async sendBatch(withdrawals, asset, network) {
    // sendmany
    const outputs = {};
    for (const w of withdrawals) {
      const amount = new Decimal(w.amount);
      if (outputs[w.to]) {
        outputs[w.to] = new Decimal(outputs[w.to]).plus(amount).toNumber();
      } else {
        outputs[w.to] = amount.toNumber();
      }
    }
    // minconf=6 for safety
    return await this._callRpc("sendmany", [
      "",
      outputs,
      6,
      "batch withdrawal",
    ]);
  }

  async getBalance(asset, network) {
    // getbalance "*" [minconf]
    // Bitcoin treats minconf=0 as total (including mempool)
    // We treat minconf=1 as spendable (confirmed)

    // Note: 'getbalance' with minconf=0 might include unconfirmed change from our own txs,
    // which is spendable in Bitcoin, but 'unconfirmed' from others is not safely spendable.
    // For safety in this service, we stick to confirmed=spendable.

    const unconfirmedTotal = await this._callRpc("getbalance", ["*", 0]);
    const confirmedTotal = await this._callRpc("getbalance", ["*", 1]);

    const total = new Decimal(unconfirmedTotal);
    const spendable = new Decimal(confirmedTotal);
    const locked = total.minus(spendable);

    return {
      total: total.toFixed(8),
      spendable: spendable.toFixed(8),
      locked: locked.toFixed(8),
      lock_reason: locked.gt(0) ? "unconfirmed" : null,
    };
  }
}

/**
 * Monero Wallet Adapter
 * Ref: https://docs.getmonero.org/rpc-library/wallet-rpc/
 */
export class MoneroWalletAdapter {
  constructor(config) {
    this.rpcUrl = config.rpcUrl; // e.g., http://127.0.0.1:18081/json_rpc
    this.rpcUser = config.rpcUser;
    this.rpcPass = config.rpcPass;
  }

  async _callRpc(method, params = {}) {
    try {
      const payload = {
        jsonrpc: "2.0",
        id: "wallet-service",
        method,
        params,
      };

      const options = {};
      if (this.rpcUser) {
        options.auth = {
          username: this.rpcUser,
          password: this.rpcPass,
        };
      }

      const response = await axios.post(this.rpcUrl, payload, options);

      if (response.data.error) {
        throw new Error(
          `RPC Error ${response.data.error.code}: ${response.data.error.message}`,
        );
      }
      return response.data.result;
    } catch (error) {
      const msg = error.response?.data?.error?.message || error.message;
      console.error(`Monero RPC Error [${method}]:`, msg);
      throw new Error(`Monero RPC Failed: ${msg}`);
    }
  }

  async createAddress(asset, network) {
    const result = await this._callRpc("create_address", {
      account_index: 0,
      label: `deposit-${uuidv4()}`,
    });
    return result.address;
  }

  async sendBatch(withdrawals, asset, network) {
    const destinations = withdrawals.map((w) => ({
      amount: new Decimal(w.amount).times(1e12).toNumber(),
      address: w.to,
    }));

    const result = await this._callRpc("transfer_split", {
      destinations,
      account_index: 0,
      priority: 2,
      ring_size: 16,
      get_tx_keys: true,
    });

    if (result.tx_hash_list && result.tx_hash_list.length > 0) {
      return result.tx_hash_list.join(",");
    }
    return result.tx_hash || "unknown_tx_hash";
  }

  async getBalance(asset, network) {
    // get_balance
    const result = await this._callRpc("get_balance", { account_index: 0 });

    // Convert from atomic units
    const total = new Decimal(result.balance).div(1e12);
    const spendable = new Decimal(result.unlocked_balance).div(1e12);
    const locked = total.minus(spendable);

    return {
      total: total.toFixed(12),
      spendable: spendable.toFixed(12),
      locked: locked.toFixed(12),
      lock_reason: locked.gt(0) ? "protocol_lock" : null, // Monero locks funds for ~20 mins (10 blocks)
    };
  }
}

/**
 * Mock Adapter for Testing/Development
 */
export class MockWalletAdapter {
  async createAddress(asset, network) {
    return `mock_addr_${network}_${uuidv4().substring(0, 8)}`;
  }

  async sendBatch(withdrawals, asset, network) {
    console.log(
      `[Adapter] Processing batch of ${withdrawals.length} items for ${asset}/${network}...`,
    );
    await new Promise((r) => setTimeout(r, 1000));
    return `tx_${uuidv4()}`;
  }

  async getBalance(asset, network) {
    // Simulate a scenario where some funds are locked
    return {
      total: "50000.00",
      spendable: "45000.00",
      locked: "5000.00",
      lock_reason: "simulated_lock",
    };
  }
}

// Factory to choose adapter based on ENV or Asset
const getAdapterInstance = (asset) => {
  if (asset === "BTC" && process.env.BTC_RPC_URL) {
    return new BitcoinWalletAdapter({
      rpcUrl: process.env.BTC_RPC_URL,
      rpcUser: process.env.BTC_RPC_USER,
      rpcPass: process.env.BTC_RPC_PASS,
    });
  }
  if (asset === "XMR" && process.env.XMR_RPC_URL) {
    return new MoneroWalletAdapter({
      rpcUrl: process.env.XMR_RPC_URL,
      rpcUser: process.env.XMR_RPC_USER,
      rpcPass: process.env.XMR_RPC_PASS,
    });
  }
  return new MockWalletAdapter();
};

// Export a proxy object that delegates to the correct adapter per call
export const walletAdapter = {
  createAddress: (asset, net) =>
    getAdapterInstance(asset).createAddress(asset, net),
  sendBatch: (withdrawals, asset, net) =>
    getAdapterInstance(asset).sendBatch(withdrawals, asset, net),
  getBalance: (asset, net) => getAdapterInstance(asset).getBalance(asset, net),
};
