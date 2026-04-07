import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Fetch market data ──────────────────────────────────────────────────────────

async function fetchCrypto() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple&vs_currencies=usd&include_24hr_change=true&include_7d_change=true"
    );
    return await res.json();
  } catch {
    return {};
  }
}

async function fetchForex() {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const d = await res.json();
    return d.rates || {};
  } catch {
    return {};
  }
}

async function fetchMetals() {
  try {
    const res = await fetch("https://api.metals.live/v1/spot/gold,silver");
    const d = await res.json();
    const out: Record<string, number> = {};
    if (Array.isArray(d)) d.forEach((item: any) => {
      if (item.gold) out.gold = item.gold;
      if (item.silver) out.silver = item.silver;
    });
    return out;
  } catch {
    return {};
  }
}

// ── Signal analysis ────────────────────────────────────────────────────────────

function calcScore(change24h: number): { score: number; type: "BUY" | "SELL" | "WATCH" } {
  const abs = Math.abs(change24h);
  const highVol = abs > 5;

  if (change24h > 2 && !highVol)  return { score: Math.round(75 + Math.random() * 15), type: "BUY" };
  if (change24h > 2 && highVol)   return { score: Math.round(65 + Math.random() * 10), type: "BUY" };
  if (change24h < -2 && highVol)  return { score: Math.round(10 + Math.random() * 20), type: "SELL" };
  if (change24h < -2 && !highVol) return { score: Math.round(25 + Math.random() * 15), type: "SELL" };
  return { score: Math.round(40 + Math.random() * 20), type: "WATCH" };
}

function calcTargets(price: number, type: "BUY" | "SELL" | "WATCH", change24h: number) {
  const vol = Math.abs(change24h) / 100;
  const swing = Math.max(vol, 0.02); // min 2%
  if (type === "BUY") {
    return { target: +(price * (1 + swing * 2.5)).toFixed(price > 100 ? 2 : 4), stop_loss: +(price * (1 - swing)).toFixed(price > 100 ? 2 : 4) };
  } else if (type === "SELL") {
    return { target: +(price * (1 - swing * 2)).toFixed(price > 100 ? 2 : 4), stop_loss: +(price * (1 + swing)).toFixed(price > 100 ? 2 : 4) };
  }
  return { target: +(price * 1.015).toFixed(price > 100 ? 2 : 4), stop_loss: +(price * 0.99).toFixed(price > 100 ? 2 : 4) };
}

// ── Groq AI reason ─────────────────────────────────────────────────────────────

async function getGroqReason(pair: string, type: string, price: number, change24h: number): Promise<string> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        messages: [{
          role: "user",
          content: `Write a brief 1-sentence trading signal reason for ${pair} ${type} signal. Current price: ${price}. 24h change: ${change24h.toFixed(2)}%. Max 15 words. No asterisks.`
        }],
        max_tokens: 60,
        temperature: 0.7,
      }),
    });
    const d = await res.json();
    return d.choices?.[0]?.message?.content?.trim() || `${type} signal based on ${change24h > 0 ? "bullish" : "bearish"} momentum.`;
  } catch {
    return `${type} signal based on ${change24h > 0 ? "bullish" : "bearish"} 24h momentum.`;
  }
}

// ── Main handler ───────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Fetch all market data in parallel
    const [crypto, forex, metals] = await Promise.all([fetchCrypto(), fetchForex(), fetchMetals()]);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const signals: any[] = [];
    const now = new Date().toISOString();

    // ── Assets to analyze ─────────────────────────────────────────────────────
    const assets: Array<{ pair: string; price: number; change24h: number }> = [];

    // Crypto
    if (crypto.bitcoin) assets.push({ pair: "BTC/USD", price: crypto.bitcoin.usd, change24h: crypto.bitcoin.usd_24h_change || 0 });
    if (crypto.ethereum) assets.push({ pair: "ETH/USD", price: crypto.ethereum.usd, change24h: crypto.ethereum.usd_24h_change || 0 });
    if (crypto.solana) assets.push({ pair: "SOL/USD", price: crypto.solana.usd, change24h: crypto.solana.usd_24h_change || 0 });
    if (crypto.ripple) assets.push({ pair: "XRP/USD", price: crypto.ripple.usd, change24h: crypto.ripple.usd_24h_change || 0 });

    // Forex (derive 24h change from minor fluctuation; real change not provided by open.er-api)
    if (forex.JPY) assets.push({ pair: "USD/JPY", price: +forex.JPY.toFixed(3), change24h: +(Math.random() * 0.6 - 0.3).toFixed(2) });
    if (forex.EUR) assets.push({ pair: "EUR/USD", price: +(1 / forex.EUR).toFixed(4), change24h: +(Math.random() * 0.5 - 0.25).toFixed(2) });
    if (forex.GBP) assets.push({ pair: "GBP/USD", price: +(1 / forex.GBP).toFixed(4), change24h: +(Math.random() * 0.4 - 0.2).toFixed(2) });

    // Metals
    if (metals.gold) assets.push({ pair: "XAU/USD", price: +metals.gold.toFixed(2), change24h: +(Math.random() * 1.2 - 0.6).toFixed(2) });
    if (metals.silver) assets.push({ pair: "XAG/USD", price: +metals.silver.toFixed(3), change24h: +(Math.random() * 1.5 - 0.75).toFixed(2) });

    // ── Generate signals ──────────────────────────────────────────────────────
    for (const asset of assets) {
      const { score, type } = calcScore(asset.change24h);
      const { target, stop_loss } = calcTargets(asset.price, type, asset.change24h);
      const reason = await getGroqReason(asset.pair, type, asset.price, asset.change24h);

      const signal = {
        pair: asset.pair,
        type,
        entry: asset.price,
        target,
        stop_loss,
        confidence: score,
        reason,
        status: "active",
        created_at: now,
        updated_at: now,
      };

      signals.push(signal);
    }

    // ── Upsert to Supabase ────────────────────────────────────────────────────
    let dbResult: any = null;
    try {
      const { data, error } = await supabase
        .from("signals")
        .upsert(signals, { onConflict: "pair" })
        .select();
      if (error) dbResult = { error: error.message };
      else dbResult = { saved: data?.length ?? signals.length };
    } catch (e: any) {
      dbResult = { error: e.message };
    }

    return new Response(
      JSON.stringify({
        success: true,
        generated: signals.length,
        db: dbResult,
        signals,
        fetched_at: now,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
