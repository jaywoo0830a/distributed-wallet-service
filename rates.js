import axios from "axios";
import Decimal from "decimal.js";

// CoinGecko IDs for the assets this service supports.
const COINGECKO_IDS = {
  BTC: "bitcoin",
  XMR: "monero",
};

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price";

/**
 * Creates a rates client backed by CoinGecko with Redis caching.
 * Falls back to null on any upstream failure so callers can render a
 * balance response even when the rate provider is unreachable.
 */
export function createRatesClient({ redis, ttlSeconds = 30 }) {
  const cacheKey = (asset) => `rate:${asset}:USD`;

  async function fetchFromCoinGecko(asset) {
    const id = COINGECKO_IDS[asset];
    if (!id) return null;

    const { data } = await axios.get(COINGECKO_URL, {
      params: { ids: id, vs_currencies: "usd" },
      timeout: 5000,
    });

    const price = data?.[id]?.usd;
    if (price === undefined || price === null) return null;
    return new Decimal(price).toFixed(2);
  }

  async function getUsdPrice(asset) {
    if (!COINGECKO_IDS[asset]) return null;

    try {
      const cached = await redis.get(cacheKey(asset));
      if (cached) return cached;
    } catch (err) {
      console.error(`[rates] redis read failed for ${asset}:`, err.message);
      // Fall through to a live fetch.
    }

    try {
      const price = await fetchFromCoinGecko(asset);
      if (price === null) return null;

      try {
        await redis.set(cacheKey(asset), price, "EX", ttlSeconds);
      } catch (err) {
        console.error(`[rates] redis write failed for ${asset}:`, err.message);
      }

      return price;
    } catch (err) {
      console.error(`[rates] CoinGecko fetch failed for ${asset}:`, err.message);
      return null;
    }
  }

  /**
   * Multiplies a crypto amount by its USD spot price.
   * Returns null if the rate is unavailable.
   */
  async function toUsd(asset, amount) {
    const price = await getUsdPrice(asset);
    if (price === null) return null;
    return new Decimal(amount).times(price).toFixed(2);
  }

  return { getUsdPrice, toUsd };
}
