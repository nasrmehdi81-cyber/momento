import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")              || "";
const SUPABASE_SVC_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GROQ_API_KEY      = Deno.env.get("GROQ_API_KEY")              || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Returns previous business day as YYYY-MM-DD (skips Sat/Sun) */
function prevBusinessDay(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0];
}

function pct(now: number, prev: number): number {
  return prev > 0 ? +((now - prev) / prev * 100).toFixed(2) : 0;
}

// ── Market data fetchers ───────────────────────────────────────────────────────

/** Crypto — CoinGecko provides real 24h change */
async function fetchCrypto(): Promise<Array<{ pair: string; price: number; change24h: number }>> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price" +
      "?ids=bitcoin,ethereum,solana,ripple" +
      "&vs_currencies=usd&include_24hr_change=true",
      { headers: { "Accept": "application/json" } }
    );
    if (!res.ok) return [];
    const d = await res.json();
    const out = [];
    if (d.bitcoin)  out.push({ pair: "BTC/USD", price: d.bitcoin.usd,  change24h: +(d.bitcoin.usd_24h_change  || 0).toFixed(2) });
    if (d.ethereum) out.push({ pair: "ETH/USD", price: d.ethereum.usd, change24h: +(d.ethereum.usd_24h_change || 0).toFixed(2) });
    if (d.solana)   out.push({ pair: "SOL/USD", price: d.solana.usd,   change24h: +(d.solana.usd_24h_change   || 0).toFixed(2) });
    if (d.ripple)   out.push({ pair: "XRP/USD", price: d.ripple.usd,   change24h: +(d.ripple.usd_24h_change   || 0).toFixed(2) });
    return out;
  } catch {
    return [];
  }
}

/**
 * Forex — Frankfurter API (ECB reference rates).
 * Fetches today + previous business day to compute REAL 24h % change.
 */
async function fetchForex(): Promise<Array<{ pair: string; price: number; change24h: number }>> {
  try {
    const yd = prevBusinessDay();
    const [rToday, rYd] = await Promise.all([
      fetch(`https://api.frankfurter.app/latest?from=USD&to=JPY,EUR,GBP,CAD,AUD`),
      fetch(`https://api.frankfurter.app/${yd}?from=USD&to=JPY,EUR,GBP,CAD,AUD`),
    ]);
    if (!rToday.ok || !rYd.ok) return [];
    const today = (await rToday.json()).rates || {};
    const yest  = (await rYd.json()).rates   || {};

    const out = [];

    // USD/JPY — direct rate
    if (today.JPY && yest.JPY)
      out.push({ pair: "USD/JPY", price: +today.JPY.toFixed(3), change24h: pct(today.JPY, yest.JPY) });

    // EUR/USD, GBP/USD, CAD/USD, AUD/USD — invert from USD base
    for (const [sym, displayPair] of [["EUR","EUR/USD"],["GBP","GBP/USD"]] as [string,string][]) {
      if (today[sym] && yest[sym]) {
        const p  = 1 / today[sym];
        const pp = 1 / yest[sym];
        out.push({ pair: displayPair, price: +p.toFixed(4), change24h: pct(p, pp) });
      }
    }

    return out;
  } catch {
    return [];
  }
}

/**
 * Metals — Frankfurter supports XAU (gold) from ECB.
 * Fetches today + previous business day for REAL 24h % change.
 * Falls back to metals.live (price only, 0% change) if Frankfurter fails.
 */
async function fetchMetals(): Promise<Array<{ pair: string; price: number; change24h: number }>> {
  // Try Frankfurter XAU (ECB tracks gold)
  try {
    const yd = prevBusinessDay();
    const [rToday, rYd] = await Promise.all([
      fetch(`https://api.frankfurter.app/latest?from=XAU&to=USD`),
      fetch(`https://api.frankfurter.app/${yd}?from=XAU&to=USD`),
    ]);
    if (rToday.ok && rYd.ok) {
      const today = (await rToday.json()).rates || {};
      const yest  = (await rYd.json()).rates   || {};
      if (today.USD && yest.USD) {
        return [{ pair: "XAU/USD", price: +today.USD.toFixed(2), change24h: pct(today.USD, yest.USD) }];
      }
    }
  } catch { /* fall through */ }

  // Fallback: metals.live (real price, change unknown → 0)
  try {
    const res = await fetch("https://api.metals.live/v1/spot/gold,silver");
    if (!res.ok) return [];
    const d = await res.json();
    const out = [];
    if (Array.isArray(d)) {
      let gold = 0, silver = 0;
      d.forEach((item: any) => {
        if (item.gold)   gold   = item.gold;
        if (item.silver) silver = item.silver;
      });
      if (gold   > 0) out.push({ pair: "XAU/USD", price: +gold.toFixed(2),   change24h: 0 });
      if (silver > 0) out.push({ pair: "XAG/USD", price: +silver.toFixed(3), change24h: 0 });
    }
    return out;
  } catch {
    return [];
  }
}

// ── Signal logic ───────────────────────────────────────────────────────────────

/**
 * Deterministic confidence score — no Math.random().
 * Based on actual 24h momentum magnitude.
 *   |change| ≥ 4%  → 82–92 confidence
 *   |change| 2–4%  → 65–82
 *   |change| 1–2%  → 55–65
 *   |change| < 1%  → 38–55  (WATCH)
 */
function calcScore(change24h: number): { score: number; type: "BUY" | "SELL" | "WATCH" } {
  const abs = Math.abs(change24h);

  if (change24h >= 4)  return { score: Math.min(92, Math.round(82 + abs * 2)), type: "BUY"  };
  if (change24h >= 2)  return { score: Math.min(82, Math.round(65 + abs * 8)), type: "BUY"  };
  if (change24h >= 1)  return { score: Math.round(55 + abs * 5),               type: "BUY"  };
  if (change24h <= -4) return { score: Math.min(92, Math.round(82 + abs * 2)), type: "SELL" };
  if (change24h <= -2) return { score: Math.min(82, Math.round(65 + abs * 8)), type: "SELL" };
  if (change24h <= -1) return { score: Math.round(55 + abs * 5),               type: "SELL" };
  return { score: Math.max(38, Math.round(55 - abs * 10)), type: "WATCH" };
}

/**
 * ATR-based targets — no Math.random().
 * Daily ATR ≈ |change24h|% of price (min 1%).
 * BUY:  TP = entry + 2.5×ATR  |  SL = entry - 1×ATR  → RR ~1:2.5
 * SELL: TP = entry - 2×ATR    |  SL = entry + 1×ATR  → RR ~1:2
 */
function calcTargets(price: number, type: "BUY" | "SELL" | "WATCH", change24h: number) {
  const dec   = price > 100 ? 2 : 4;
  const atr   = Math.max(Math.abs(change24h) / 100, 0.01) * price;  // min 1% ATR

  if (type === "BUY")  return { target: +(price + atr * 2.5).toFixed(dec), stop_loss: +(price - atr).toFixed(dec) };
  if (type === "SELL") return { target: +(price - atr * 2).toFixed(dec),   stop_loss: +(price + atr).toFixed(dec) };
  return { target: +(price + atr).toFixed(dec), stop_loss: +(price - atr * 0.5).toFixed(dec) };
}

/**
 * Data-driven reason — based on real change24h, no AI needed.
 * Used as primary reason OR fallback if Groq unavailable.
 */
function buildReason(pair: string, type: string, price: number, change24h: number): string {
  const sign = change24h >= 0 ? "+" : "";
  const ch   = `${sign}${change24h.toFixed(2)}%`;
  const abs  = Math.abs(change24h);
  const str  = abs >= 3 ? "strong" : abs >= 1.5 ? "moderate" : "slight";

  if (type === "BUY")
    return `${pair} gained ${ch} in 24h — ${str} bullish momentum. Entry at ${price}, targeting a continuation move higher.`;
  if (type === "SELL")
    return `${pair} fell ${ch} in 24h — ${str} selling pressure. Entry at ${price}, targeting further downside.`;
  return `${pair} is flat at ${ch} over 24h — no clear trend. Wait for a break above resistance or below support.`;
}

/** Groq AI enhances the reason if API key is available; falls back to data-driven reason */
async function getReason(pair: string, type: string, price: number, change24h: number): Promise<string> {
  const fallback = buildReason(pair, type, price, change24h);
  if (!GROQ_API_KEY) return fallback;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        messages: [{
          role: "user",
          content:
            `Trading signal: ${pair} ${type} @ ${price}. Real 24h change: ${change24h.toFixed(2)}%. ` +
            `Write ONE sentence (max 20 words) explaining WHY this is a ${type} signal based on the actual price movement. ` +
            `Be factual, no asterisks, no generic phrases.`,
        }],
        max_tokens: 80,
        temperature: 0.3,
      }),
    });
    if (!res.ok) return fallback;
    const d   = await res.json();
    const txt = d.choices?.[0]?.message?.content?.trim();
    return txt && txt.length > 10 ? txt : fallback;
  } catch {
    return fallback;
  }
}

// ── Main handler ───────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const [cryptoAssets, forexAssets, metalAssets] = await Promise.all([
      fetchCrypto(),
      fetchForex(),
      fetchMetals(),
    ]);

    const assets = [...cryptoAssets, ...forexAssets, ...metalAssets];

    if (assets.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "All market data sources failed" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const now     = new Date().toISOString();
    const signals: any[] = [];

    for (const asset of assets) {
      const { score, type }   = calcScore(asset.change24h);
      const { target, stop_loss } = calcTargets(asset.price, type, asset.change24h);
      const reason            = await getReason(asset.pair, type, asset.price, asset.change24h);

      signals.push({
        pair:       asset.pair,
        type,
        entry:      asset.price,
        target,
        stop_loss,
        confidence: score,
        reason,
        change24h:  asset.change24h,   // store for transparency
        status:     "active",
        created_at: now,
        updated_at: now,
      });
    }

    // Upsert to Supabase
    let dbResult: any = { skipped: "no supabase config" };
    if (SUPABASE_URL && SUPABASE_SVC_KEY) {
      try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);
        const { data, error } = await supabase
          .from("signals")
          .upsert(signals, { onConflict: "pair" })
          .select();
        dbResult = error ? { error: error.message } : { saved: data?.length ?? signals.length };
      } catch (e: any) {
        dbResult = { error: e.message };
      }
    }

    return new Response(
      JSON.stringify({ success: true, generated: signals.length, db: dbResult, signals, fetched_at: now }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
