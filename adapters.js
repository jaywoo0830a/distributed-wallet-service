import axios from "axios";
import Decimal from "decimal.js";
import { v4 as uuidv4 } from "uuid";

// --- Wallet Adapter Interface & Implementations ---

/**
 * Interface for Wallet Adapters
 *
 * createAddress(asset, network): Promise<string>
 * sendBatch(withdrawals, asset, network): Promise<string> (returns txid)
 * getBalance(asset, network): Promise<{ total: string, spendable: string }>
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
          // Keep-Alive connection recommended for frequent RPC calls
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
      // Axios error handling details
      const msg = error.response?.data?.error?.message || error.message;
      console.error(`Bitcoin RPC Error [${method}]:`, msg);
      throw new Error(`Bitcoin RPC Failed: ${msg}`);
    }
  }

  async createAddress(asset, network) {
    // getnewaddress [label] [address_type]
    // label: "" (empty default), address_type: "bech32" (SegWit native)
    // Ref: https://developer.bitcoin.org/reference/rpc/getnewaddress.html
    const address = await this._callRpc("getnewaddress", [
      "wallet-service-deposit",
      "bech32",
    ]);
    return address;
  }

  async sendBatch(withdrawals, asset, network) {
    // sendmany "" {"address": amount} [minconf] [comment] [subtractfeefrom]
    // Ref: https://developer.bitcoin.org/reference/rpc/sendmany.html

    // 1. Aggregate amounts by destination address (Bitcoin sendmany requires unique keys)
    const outputs = {};
    for (const w of withdrawals) {
      const amount = new Decimal(w.amount);
      if (outputs[w.to]) {
        outputs[w.to] = new Decimal(outputs[w.to]).plus(amount).toNumber();
      } else {
        outputs[w.to] = amount.toNumber();
      }
    }

    // 2. Call sendmany
    // arg0: "" (dummy, legacy account name)
    // arg1: outputs object
    // arg2: 6 (minconf - only use funds confirmed by 6 blocks for safety)
    // arg3: "batch withdrawal" (comment)
    return await this._callRpc("sendmany", [
      "",
      outputs,
      6,
      "batch withdrawal",
    ]);
  }

  async getBalance(asset, network) {
    // getbalance "*" [minconf] [include_watchonly]
    // Ref: https://developer.bitcoin.org/reference/rpc/getbalance.html

    // We use minconf=1 for spendable balance to allow fast movement,
    // but minconf=6 is safer for 'total' confirmed.
    // For simplicity, we treat minconf=1 as spendable.

    const unconfirmed = await this._callRpc("getbalance", ["*", 0]);
    const confirmed = await this._callRpc("getbalance", ["*", 1]);

    return {
      total: new Decimal(unconfirmed).toFixed(8),
      spendable: new Decimal(confirmed).toFixed(8),
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
    // create_address
    // Create a new subaddress for account 0.
    // Ref: https://docs.getmonero.org/rpc-library/wallet-rpc/#create_address
    const result = await this._callRpc("create_address", {
      account_index: 0,
      label: `deposit-${uuidv4()}`, // Unique label for tracking
    });
    return result.address;
  }

  async sendBatch(withdrawals, asset, network) {
    // transfer_split
    // Sends funds to multiple destinations, splitting into multiple txs if necessary.
    // Ref: https://docs.getmonero.org/rpc-library/wallet-rpc/#transfer_split

    // Convert amounts to atomic units (1 XMR = 1e12 atomic units)
    const destinations = withdrawals.map((w) => ({
      amount: new Decimal(w.amount).times(1e12).toNumber(), // must be integer
      address: w.to,
    }));

    const result = await this._callRpc("transfer_split", {
      destinations,
      account_index: 0,
      priority: 2, // 0: default, 1: unimportant, 2: normal, 3: elevated
      ring_size: 16, // Enforce ring size (current protocol standard)
      get_tx_keys: true,
    });

    // transfer_split returns `tx_hash_list`. We return the first one as a reference
    // or join them if multiple txs were created.
    if (result.tx_hash_list && result.tx_hash_list.length > 0) {
      return result.tx_hash_list.join(",");
    }
    // Fallback if older version or single hash returned in strictly 'transfer'
    return result.tx_hash || "unknown_tx_hash";
  }

  async getBalance(asset, network) {
    // get_balance
    // Ref: https://docs.getmonero.org/rpc-library/wallet-rpc/#get_balance
    const result = await this._callRpc("get_balance", { account_index: 0 });

    // result.balance: Total balance (atomic units)
    // result.unlocked_balance: Spendable balance (atomic units)
    return {
      total: new Decimal(result.balance).div(1e12).toFixed(12),
      spendable: new Decimal(result.unlocked_balance).div(1e12).toFixed(12),
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
    await new Promise((r) => setTimeout(r, 1000)); // Simulate latency
    return `tx_${uuidv4()}`;
  }

  async getBalance(asset, network) {
    // Mocking balance. In reality, this would fetch from chain/node.
    return { total: "50000.00", spendable: "45000.00" };
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
