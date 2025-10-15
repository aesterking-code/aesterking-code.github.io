// dexscreenerProxy.mjs
// Node 18+ (uses global fetch)

import { ethers } from "ethers";
import fs from "fs";

// ---------- CONFIG ----------
const BNB_PAIR_URL =
  "https://api.dexscreener.com/latest/dex/pairs/bsc/0x46b9217342CdC50c89FfA84A12Be45b2639eAf4A";

// Polygon RPC
const POLYGON_RPC = "https://virtual.binance.eu.rpc.tenderly.co/c606b3b6-e6be-4fcc-b248-dc824139456e";
const CHAIN_ID = 56;

// Wrapped POL on Polygon PoS
const WPOL = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"; // 18 decimals

// Keep YOUR addresses as-is (the ones you said work locally)
const TOKENS = {
  XBNB: {
    token: "0xBf8a6A3DebAe07744C5ae465eE573cf186ACf0e5",
    decimals: 18,
    lpWithPOL: "0x33a0fd5759a934506e917fe5f7f4f0e21604f729",
  },
  B4NK: {
    token: "0x695d2C42e93650DED61A7E474A20c516150eBa58",
    decimals: 18,
    lpWithPOL: "0x9bF4b58C8dd702f12A8560aa125CfCE2f9F969ad",
  },
};

// ---------- ABIs ----------
const IUniswapV2Pair = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

// ---------- HELPERS ----------
const toFixedWei = (usd) => BigInt(Math.round(Number(usd) * 1e18)); // encode USD value as 18-dec string
const bnToFloat = (bn, decimals) => Number(ethers.formatUnits(bn, decimals));

/**
 * price(token in quote) = (reserveQuote/10^qDec) / (reserveToken/10^tDec)
 * Returns token price in units of `quote` (here: POL)
 */
async function priceFromLP(provider, lpAddr, tokenAddr, tokenDecimals, quoteAddr, quoteDecimals = 18) {
  const lp = new ethers.Contract(lpAddr, IUniswapV2Pair, provider);
  const [token0, token1] = await Promise.all([lp.token0(), lp.token1()]);
  const { reserve0, reserve1 } = await lp.getReserves();

  let reserveToken, reserveQuote;
  if (token0.toLowerCase() === tokenAddr.toLowerCase() && token1.toLowerCase() === quoteAddr.toLowerCase()) {
    reserveToken = reserve0;
    reserveQuote = reserve1;
  } else if (token1.toLowerCase() === tokenAddr.toLowerCase() && token0.toLowerCase() === quoteAddr.toLowerCase()) {
    reserveToken = reserve1;
    reserveQuote = reserve0;
  } else {
    throw new Error(`LP ${lpAddr} is not a ${tokenAddr} - ${quoteAddr} pair`);
  }

  return bnToFloat(reserveQuote, quoteDecimals) / bnToFloat(reserveToken, tokenDecimals);
}

/** BNB price (USD) via DexScreener; invert USD1/WBNB */
async function getBnbUsdFromDexScreener() {
  const r = await fetch(BNB_PAIR_URL);
  if (!r.ok) throw new Error(`DexScreener HTTP ${r.status}`);
  const data = await r.json();
  const pair = data?.pair || data?.pairs?.[0];
  if (!pair) throw new Error("No pair data for BNB");
  const priceUsdBase = Number(pair.priceUsd);
  const priceNative = Number(pair.priceNative);
  if (!priceUsdBase || !priceNative) throw new Error("Missing fields for BNB price");
  return priceUsdBase / priceNative; // <-- USD
}

async function main() {
  const out = {
    updatedAt: new Date().toISOString(),
    prices: {
      BNB:  { priceInEth: null, priceInWei: null, error: null }, // both represent USD value
      XBNB: { priceInEth: null, priceInWei: null, error: null },
      B4NK: { priceInEth: null, priceInWei: null, error: null },
    },
  };

  // 1) BNB in USD (direct)
  let bnbUsd = null;
  try {
    bnbUsd = await getBnbUsdFromDexScreener(); // <-- USD
    out.prices.BNB.priceInEth = Number(bnbUsd);                 // number (USD)
    out.prices.BNB.priceInWei = toFixedWei(bnbUsd).toString();  // 18-dec string (USD)
  } catch (err) {
    out.prices.BNB.error = String(err?.message ?? err);
  }

  // 2) Polygon tokens -> token price in POL, multiply by *BNB USD* (as requested)
  if (bnbUsd !== null) {
    const provider = new ethers.JsonRpcProvider(POLYGON_RPC, CHAIN_ID);

    for (const [symbol, cfg] of Object.entries(TOKENS)) {
      try {
        const priceInPOL = await priceFromLP(
          provider,
          cfg.lpWithPOL,
          cfg.token,
          cfg.decimals,
          WPOL,
          18
        ); // token price in POL

        const usd = priceInPOL * bnbUsd; // <-- using BNB USD in place of POL USD (intentional)
        out.prices[symbol].priceInEth = Number(usd); // number (USD)
        out.prices[symbol].priceInWei = toFixedWei(usd).toString(); // 18-dec string (USD)
      } catch (err) {
        out.prices[symbol].error = String(err?.message ?? err);
      }
    }
  } else {
    // if BNB failed, mark both as failed (since they depend on it)
    out.prices.XBNB.error = out.prices.XBNB.error ?? "BNB USD unavailable";
    out.prices.B4NK.error = out.prices.B4NK.error ?? "BNB USD unavailable";
  }

  // Always write current snapshot
  fs.writeFileSync("price.json", JSON.stringify(out, null, 2));
  console.log("💾 Wrote price.json");

  // Write last-good only if *all* calls succeeded (no error fields)
  const allGood = Object.values(out.prices).every((p) => p.error === null);
  if (allGood) {
    fs.writeFileSync("price.last-good.json", JSON.stringify(out, null, 2));
    console.log("✅ Updated price.last-good.json");
  } else {
    console.log("⚠️ Not updating price.last-good.json (one or more errors present).");
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  // still emit a file so the workflow can commit something
  const fallback = {
    updatedAt: new Date().toISOString(),
    prices: {
      BNB:  { priceInEth: null, priceInWei: null, error: String(e?.message ?? e) },
      XBNB: { priceInEth: null, priceInWei: null, error: String(e?.message ?? e) },
      B4NK: { priceInEth: null, priceInWei: null, error: String(e?.message ?? e) },
    },
  };
  try { fs.writeFileSync("price.json", JSON.stringify(fallback, null, 2)); } catch {}
  // Intentionally *do not* touch price.last-good.json on fatal
  process.exit(1);
});
