import axios from "axios";
import Decimal from "decimal.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Bitcoin Wallet Adapter
 */
export class BitcoinWalletAdapter {
  constructor(config) {
    this.rpcUrl = config.rpcUrl;
    this.rpcUser = config.rpcUser;
    this.rpcPass = config.rpcPass;
  }

  async _callRpc(method, params = []) {
    try {
      console.log(`[BTC-RPC] Attempting ${method} at ${this.rpcUrl}`);
      
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
          headers: { "Content-Type": "application/json" },
          timeout: 10000,
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
    const outputs = {};
    for (const w of withdrawals) {
      const amount = new Decimal(w.amount);
      if (outputs[w.to]) {
        outputs[w.to] = new Decimal(outputs[w.to]).plus(amount).toNumber();
      } else {
        outputs[w.to] = amount.toNumber();
      }
    }
    // sendmany "" {address:amount,...} [minconf=1 for regtest]
    return await this._callRpc("sendmany", [
      "",
      outputs,
      1,
      "batch withdrawal",
    ]);
  }

  async getBalance(asset, network) {
    // getbalance "*" 0 -> Total (including unconfirmed)
    // getbalance "*" 1 -> Spendable (confirmed)
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
 */
export class MoneroWalletAdapter {
  constructor(config) {
    this.rpcUrl = config.rpcUrl;
    this.rpcUser = config.rpcUser;
    this.rpcPass = config.rpcPass;
  }

  async _callRpc(method, params = {}) {
    try {
      console.log(`[XMR-RPC] Attempting ${method} at ${this.rpcUrl}`);
      
      const payload = {
        jsonrpc: "2.0",
        id: "wallet-service",
        method,
        params,
      };

      const options = {
        headers: { "Content-Type": "application/json" },
        timeout: 20000
      };
      
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
    // Monero uses atomic units (1 XMR = 10^12 piconero)
    const destinations = withdrawals.map((w) => ({
      amount: new Decimal(w.amount).times(1e12).toDecimalPlaces(0).toNumber(),
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
    const result = await this._callRpc("get_balance", { account_index: 0 });

    const total = new Decimal(result.balance).div(1e12);
    const spendable = new Decimal(result.unlocked_balance).div(1e12);
    const locked = total.minus(spendable);

    return {
      total: total.toFixed(12),
      spendable: spendable.toFixed(12),
      locked: locked.toFixed(12),
      lock_reason: locked.gt(0) ? "protocol_lock" : null,
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
    console.log(`[MockAdapter] Sending mock batch`);
    return `tx_mock_${uuidv4()}`;
  }

  async getBalance(asset, network) {
    return {
      total: "100.00",
      spendable: "90.00",
      locked: "10.00",
      lock_reason: "mock_locking",
    };
  }
}

// Factory resolver
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

export const walletAdapter = {
  createAddress: (asset, net) => getAdapterInstance(asset).createAddress(asset, net),
  sendBatch: (withdrawals, asset, net) => getAdapterInstance(asset).sendBatch(withdrawals, asset, net),
  getBalance: (asset, net) => getAdapterInstance(asset).getBalance(asset, net),
};