// game.js — mining + submit + read-only state (TMF Passport only)

import { ethers } from "https://esm.sh/ethers@6.13.2";

// ---- CONFIG ----
export const MONAD_RPC = "https://testnet-rpc.monad.xyz";
export const MONOMINE_ADDRESS = "0x49c52AEb95BEA2E22bede837B77C4e482840751e";
export const RELAY_ENDPOINT = "https://losarchos.com/api/forward";
export const EXPLORER_ADDR_PREFIX = "https://testnet.monadexplorer.com/address/";
export const EXPLORER_TX_PREFIX   = "https://testnet.monadexplorer.com/tx/";
export const PASSPORT_MINT_URL =
  "https://warpcast.com/~/compose?text=Mint%20your%20TMF%20Passport%20to%20play%20MonoMine&embeds[]=https%3A%2F%2Flosarchos.com%2Fframe";

// ---- DOM helpers ----
export const $$ = (id) => document.getElementById(id);
export function setTextEventually(id, text, tries = 20) {
  const el = document.getElementById(id);
  if (el) { el.textContent = text; return true; }
  if (tries > 0) requestAnimationFrame(() => setTextEventually(id, text, tries - 1));
  return false;
}
export function enableEventually(id, enabled = true, tries = 20) {
  const el = document.getElementById(id);
  if (el) { el.disabled = !enabled; return true; }
  if (tries > 0) requestAnimationFrame(() => enableEventually(id, enabled, tries - 1));
  return false;
}
export function showLinkEventually(id, href, tries = 20) {
  const el = document.getElementById(id);
  if (el) { if (href) el.href = href; el.style.display = "inline-block"; return true; }
  if (tries > 0) requestAnimationFrame(() => showLinkEventually(id, href, tries - 1));
  return false;
}

// ---- State ----
export let readProvider, provider, signer, contract, writeContract, account;
export let seedHex = null;
export let mining = false;
export let best = { hash: null, nonce: null, value: 2n ** 256n - 1n };
export let hashes = 0;
export let lastTick = Date.now();

// ---- Utils ----
function log(...args){ console.log("[MonoMine]", ...args); }
export function short(addr) { return addr ? addr.slice(0,6) + "…" + addr.slice(-4) : "—"; }
function shortHash(h){ return h ? `${h.slice(0,6)}…${h.slice(-4)}` : "—"; }

// --- lightweight chainId cache to avoid rate-limiting ---
let _chainIdCache = null;
let _chainIdCacheAt = 0;
async function getChainIdSafe(prov) {
  const now = Date.now();
  // reuse the cached value for 10s
  if (_chainIdCache !== null && (now - _chainIdCacheAt) < 10000) return _chainIdCache;
  try {
    const net = await prov.getNetwork();
    _chainIdCache = Number(net.chainId);
    _chainIdCacheAt = now;
    return _chainIdCache;
  } catch {
    return _chainIdCache; // may be null; callers should handle
  }
}





// ---- ABI ----
export async function loadAbi() {
  const j = await fetch("./contracts/MonoMine.json").then(r => r.json());
  return j.abi || j;
}

// ---- Contract init ----
export async function initGame() {
  const abi = await loadAbi();
  readProvider = new ethers.JsonRpcProvider(MONAD_RPC);
  contract = new ethers.Contract(MONOMINE_ADDRESS, abi, readProvider);

  // Debug probe (prints TMF config + chainId)
  await debugEnvProbe();

  // Leaderboard
  await initTodayLeaderboard();

  // Modal close wiring (id must exist in HTML)
  document.getElementById("sm_close")?.addEventListener("click", () => closeSubmitModal());
}

export async function refreshState() {
  try {
    const day   = await contract.day();
    const seed  = await contract.seed();
    const bestS = await contract.bestOfDay(day);
    seedHex = seed;

    setTextEventually("day",  day.toString());
    setTextEventually("seed", seedHex);

    const leaderEl = $$("leader");
    if (leaderEl) {
      leaderEl.innerHTML = (bestS.player === ethers.ZeroAddress)
        ? "—"
        : `<a class="link" target="_blank" href="${EXPLORER_ADDR_PREFIX}${bestS.player}">${short(bestS.player)}</a> (FID ${bestS.fid}) @ ${bestS.bestHash}`;
    }

    await refreshTodayIfDayChanged();
  } catch (e) {
    console.error(e);
  }
}

// ---- Mining ----
function randNonce() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "0x" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}
let nonceCounter = 1n;
function nextNonceHex() {
  const h = nonceCounter.toString(16).padStart(64, "0");
  nonceCounter += 1n;
  return "0x" + h;
}

export async function toggleMine() {
  if (!seedHex) { await refreshState(); if (!seedHex) return; }
  mining = !mining;
  setTextEventually("mineBtn", mining ? "Stop Mining" : "Start Mining");
  if (mining) void mineLoop();
}

async function mineLoop() {
  const BATCH = 2048;
  const fidHex = ethers.toBeHex(0, 32); // we don’t know user FID until submit; hash definition allows 0 here client-side

  let localSeed = seedHex;
  let seedBytes = ethers.getBytes(localSeed);
  const fidBytes = ethers.getBytes(fidHex);

  try {
    while (mining) {
      for (let i = 0; i < BATCH && mining; i++) {
        const nonce = nextNonceHex(); // or randNonce()
        const nonceBytes = ethers.getBytes(nonce);

        const h  = ethers.keccak256(ethers.concat([seedBytes, fidBytes, nonceBytes]));
        const hv = BigInt(h);
        hashes++;

        if (hv < best.value) {
          const score = leadingZeroBits(h);
          best = { hash: h, nonce, value: hv, score };
          improves += 1;
          lastImproveTs = Date.now();

          setTextEventually("bestHash",  best.hash);
          setTextEventually("bestNonce", best.nonce);
          setTextEventually("bestScore", `difficulty: ${score} bits`);
          setTextEventually("bestCount", `improvements: ${improves}`);
          setTextEventually("bestAgo",   `last improve: just now`);
        }
      }
      await new Promise(r => setTimeout(r, 0));

      if (seedHex !== localSeed) {
        localSeed = seedHex || (await (async () => { await refreshState(); return seedHex; })());
        if (!localSeed) break;
        seedBytes = ethers.getBytes(localSeed);
      }
      setTextEventually("bestAgo", `last improve: ${fmtSince(lastImproveTs)}`);
    }
  } catch (e) {
    console.error("Mining loop error:", e);
    mining = false;
    setTextEventually("mineBtn", "Start Mining");
  }
}

export function updateRate() {
  const el = $$("rate");
  if (!el) return;
  if (typeof lastTick !== "number") lastTick = Date.now();
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  if (dt >= 0.95) {
    const rate = Math.round(hashes / dt);
    el.textContent = `hashes/s: ${Number.isFinite(rate) ? rate : 0}`;
    hashes = 0;
    lastTick = now;
  }
}

// Extra mining telemetry
let improves = 0;
let lastImproveTs = null;
function leadingZeroBits(hex32) {
  const s = hex32.slice(2);
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const nib = parseInt(s[i], 16);
    if (nib === 0) { bits += 4; continue; }
    if (nib & 0x8) return bits + 0;
    if (nib & 0x4) return bits + 1;
    if (nib & 0x2) return bits + 2;
    return bits + 3;
  }
  return 256;
}
function fmtSince(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}m ${r}s`;
}

// ---- Submit path (TMF Passport only) ----
const useRelayEl = $$("useRelay");
export const useRelay = () => (useRelayEl ? useRelayEl.checked : true);

async function ensureMonadTestnet() {
  if (!window.ethereum) throw new Error("No wallet");
  const prov = new ethers.BrowserProvider(window.ethereum, "any");

  // use cached value if fresh
  const cid = await getChainIdSafe(prov);
  if (cid === 10143) return;

  // if cache was stale or wrong, double-check once
  try {
    const net = await prov.getNetwork();
    if (Number(net.chainId) === 10143) {
      _chainIdCache = 10143; _chainIdCacheAt = Date.now();
      return;
    }
  } catch { /* continue */ }

  // switch (and add+switch if needed)
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279F" }] });
    _chainIdCache = 10143; _chainIdCacheAt = Date.now();
  } catch (err) {
    if (err?.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x279F",
          chainName: "Monad Testnet",
          rpcUrls: ["https://testnet-rpc.monad.xyz"],
          nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
          blockExplorerUrls: ["https://testnet.monadexplorer.com/"]
        }]
      });
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279F" }] });
      _chainIdCache = 10143; _chainIdCacheAt = Date.now();
    } else {
      throw err;
    }
  }
}


async function getCooldownRemaining(addr) {
  try {
    const d = await contract.day();
    const [cd, last] = await Promise.all([
      contract.cooldownSeconds(),
      contract.lastSubmitAt(d, addr),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const remain = Number(cd) - Math.max(0, now - Number(last));
    return remain > 0 ? remain : 0;
  } catch { return 0; }
}
async function isPaused() { try { return await contract.paused(); } catch { return false; } }

// TMF Passport: combined status (NFT + FID)
export async function getPassportStatus(addr) {
  try {
    const passAddr = await contract.passport();
    if (!passAddr || passAddr === ethers.ZeroAddress) {
      return { hasNft: false, fid: 0n };
    }
    const erc721Abi = ["function balanceOf(address) view returns (uint256)"];
    const ipAbi     = ["function fidOf(address) view returns (uint256)"];
    const pass721   = new ethers.Contract(passAddr, erc721Abi, readProvider);
    const passCore  = new ethers.Contract(passAddr, ipAbi,     readProvider);

    const [bal, fid] = await Promise.all([
      pass721.balanceOf(addr).catch(()=>0n),
      passCore.fidOf(addr).catch(()=>0n),
    ]);

    return { hasNft: (BigInt(bal||0) > 0n), fid: BigInt(fid||0) };
  } catch {
    return { hasNft: false, fid: 0n };
  }
}

// Back-compat: allow boolean OR object
export function setPassportStatus(ok) {
  const el = $$("passportStatus");
  if (!el) return;
  el.innerHTML = ok
    ? `Passport: <span class="badge ok">Found</span>`
    : `Passport: <span class="badge no">Not found</span>`;
}

function decodeRpcErrorVerbose(e) {
  const raw = e?.data?.message || e?.info?.error?.message || e?.shortMessage || e?.message || String(e);
  const m = raw.toLowerCase();
  if (m.includes("gas_limit too high"))  return "Relay cap hit: try again or submit directly. (" + raw + ")";
  if (m.includes("quota"))               return "Out of free relay quota today. (" + raw + ")";
  if (m.includes("passport"))            return "You need a TMF Passport to submit. (" + raw + ")";
  if (m.includes("higher priority"))     return "Network busy — retrying… (" + raw + ")";
  if (m.includes("user rejected"))       return "Transaction rejected in wallet.";
  if (m.includes("insufficient funds"))  return "Not enough MON for gas.";
  if (m.includes("execution reverted"))  return "Reverted by contract (cooldown/passport/paused). (" + raw + ")";
  return raw;
}

async function preflightSubmit(addr) {
  log("preflight: begin", { addr });

  // 1) network
  try {
    if (!provider) throw new Error("No provider");
    const net = await provider.getNetwork();
    log("preflight: network", Number(net?.chainId || 0));
    if (Number(net.chainId) !== 10143) {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x279F" }],
        });
      } catch (err) {
        if (err?.code === 4902) {
          await addMonadNetwork();
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x279F" }],
          });
        } else {
          throw new Error("Please switch to Monad Testnet (10143).");
        }
      }
    }
  } catch {
    throw new Error("Wallet is not on Monad Testnet (10143).");
  }

  // 2) paused
  const paused = await isPaused();
  log("preflight: paused?", paused);
  if (paused) throw new Error("Game is currently paused.");

  // 3) passport (NFT only — no FID gating)
  const hasNft = await hasPassport(addr);
  log("preflight: passport NFT?", hasNft);
  if (!hasNft) {
    throw new Error("No TMF Passport found for this wallet.");
  }

  // 4) cooldown
  const left = await getCooldownRemaining(addr);
  log("preflight: cooldown left (s)", left);
  if (left > 0) throw new Error(`Cooldown active: wait ${left}s.`);

  log("preflight: ok");
}

export async function submitBest() {
  const txMsg = document.getElementById("txMsg");
  const put = (t) => { if (txMsg) txMsg.textContent = t; };

  if (!signer) await connect();
  if (!best.nonce) { put("Mine first to get a nonce."); return; }

  openSubmitModal("Submitting…", "Running preflight checks…");

  try {
    await preflightSubmit(account);
  } catch (why) {
    const msg = String(why?.message || why);
    log("submit: preflight failed:", msg);
    put(msg);
    updateSubmitModal(msg);
    return;
  }

  try {
    if (useRelay()) {
      // ✅ Do NOT simulate here — relay uses trusted forwarder
      put("Relaying (gasless)…");
      updateSubmitModal("Sending through TMF relay…");

      const gasEst   = await writeContract.submit.estimateGas(best.nonce).catch(()=>null);
      const gasLimit = gasEst ? Math.ceil(Number(gasEst) * 1.25) : 300000;
      log("submit: relay gas estimate", { gasEst: String(gasEst||"n/a"), gasLimit });

      const data = writeContract.interface.encodeFunctionData("submit", [best.nonce]);
      const { txHash } = await submitViaRelay(data, gasLimit);

      const link = `<a href="${EXPLORER_TX_PREFIX}${txHash}" target="_blank" class="link">${txHash.slice(0,6)}…${txHash.slice(-4)}</a>`;
      updateSubmitModal("Relay accepted — waiting for confirmation…", link);

      const rec = await readProvider.waitForTransaction(txHash);
      log("submit: relay receipt", rec);
      if (rec && rec.status === 1) {
        put(`Confirmed: ${txHash}`);
        updateSubmitModal(`Confirmed in block ${rec.blockNumber}`, link);
      } else {
        const detail = await explainTxFailure(txHash, "Relay path");
        put(`Tx failed: ${txHash}`);
        updateSubmitModal(`Tx failed. ${detail}`, link);
      }
    } else {
      // ✅ Direct wallet path: simulation is OK
      put("Submitting tx…");
      updateSubmitModal("Simulating then broadcasting from your wallet…");

      try {
        log("submit: staticCall (direct) start", { nonce: best.nonce });
        await writeContract.submit.staticCall(best.nonce);
        log("submit: staticCall (direct) ok");
      } catch (e) {
        const msg = decodeRpcErrorVerbose(e);
        log("submit: staticCall (direct) revert:", e);
        put(msg);
        updateSubmitModal(`Simulation reverted: ${msg}`);
        return;
      }

      const gas = await writeContract.submit.estimateGas(best.nonce);
      const gasLimit = Math.ceil(Number(gas) * 1.15);
      log("submit: direct gas estimate", { gas: String(gas), gasLimit });

      const tx  = await writeContract.submit(best.nonce, { gasLimit });
      const link = `<a href="${EXPLORER_TX_PREFIX}${tx.hash}" target="_blank" class="link">${tx.hash.slice(0,6)}…${tx.hash.slice(-4)}</a>`;
      updateSubmitModal("Broadcasted — waiting for confirmation…", link);

      const rec = await tx.wait();
      log("submit: direct receipt", rec);
      if (rec && rec.status === 1) {
        put(`Submitted: ${tx.hash}`);
        updateSubmitModal(`Confirmed in block ${rec.blockNumber}`, link);
      } else {
        const detail = await explainTxFailure(tx.hash, "Direct path");
        put(`Tx failed: ${tx.hash}`);
        updateSubmitModal(`Tx failed. ${detail}`, link);
      }
    }

    await refreshState();
  } catch (e) {
    const msg = decodeRpcErrorVerbose(e);
    log("submit: error", e);
    put(msg);
    updateSubmitModal(msg);
  }
}


// Relay helper with logs + jittered retry
export async function submitViaRelay(calldata, gasLimit = 300000) {
  const body = { target: MONOMINE_ADDRESS, data: calldata, gas_limit: gasLimit };
  log("relay: POST", RELAY_ENDPOINT, body);

  const tryOnce = async () => {
    const res  = await fetch(RELAY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    log("relay: raw response", res.status, text);

    if (res.ok) {
      let json; try { json = JSON.parse(text); } catch { json = {}; }
      const txHash = json.tx_hash || json.hash || json.txHash;
      if (!txHash) throw new Error(`Relay did not return tx hash: ${text.slice(0, 200)}`);
      return { txHash };
    }

    const lower = text.toLowerCase();
    if ((res.status === 502 || res.status === 500) &&
        (lower.includes("higher priority") || lower.includes("-32603"))) {
      throw new Error("Another transaction has higher priority");
    }

    throw new Error(`Relay HTTP ${res.status}: ${text.slice(0, 200)}`);
  };

  const retries = 2;
  for (let i = 0; i <= retries; i++) {
    try { return await tryOnce(); }
    catch (err) {
      const msg = (err?.message || "").toLowerCase();
      const isPriority = msg.includes("higher priority");
      log("relay: attempt failed", i, err);
      if (!isPriority || i === retries) throw err;
      await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 300)));
    }
  }
}

// Explain failure via receipt
async function explainTxFailure(txHash, extra = "") {
  try {
    const r = await readProvider.getTransactionReceipt(txHash);
    if (!r) return `No receipt yet for ${txHash}. ${extra}`.trim();

    const lines = [];
    lines.push(`status=${r.status === 1 ? "success" : "failed"}`);
    lines.push(`block=${r.blockNumber}`);
    lines.push(`gasUsed=${r.gasUsed?.toString?.() ?? r.gasUsed}`);
    if (r.from) lines.push(`from=${r.from}`);
    if (r.to)   lines.push(`to=${r.to}`);
    if (r.logs && r.logs.length) {
      const hadSubmitted = r.logs.some(log => log.address.toLowerCase() === MONOMINE_ADDRESS.toLowerCase());
      lines.push(`logs=${r.logs.length}${hadSubmitted ? " (Submitted seen)" : ""}`);
    }
    if (extra) lines.push(extra);
    const msg = lines.join(" • ");
    log("receipt detail:", msg, r);
    return msg;
  } catch (e) {
    log("receipt fetch failed:", e);
    return `Failed to fetch receipt: ${e?.message || e}`;
  }
}

// ---- TMF Passport (legacy helper) ----
export async function hasPassport(addr) {
  try {
    const passAddr = await contract.passport();
    if (!passAddr || passAddr === ethers.ZeroAddress) return false;
    const erc721Abi = ["function balanceOf(address) view returns (uint256)"];
    const pass = new ethers.Contract(passAddr, erc721Abi, readProvider);
    const bal  = await pass.balanceOf(addr);
    return (bal && BigInt(bal) > 0n);
  } catch (e) {
    console.warn("Passport check failed:", e);
    return false;
  }
}
// ---- Leaderboard: Today (polling) ----
const TOP_N = 50;
let lb = {
  day: null,
  rows: new Map(),     // addr -> { addr, fid, bestHashBig, bestHash, submits, at }
  unsub: null,         // clearInterval handle
  renderPending: false,
  lastScanned: 0,
};
function big(h){ try { return BigInt(h); } catch { return (1n<<256n)-1n; } }
function shortAddr(a){ return a ? a.slice(0,6)+"…"+a.slice(-4) : "—"; }
function ago(ts){
  const s = Math.max(0, Math.floor(Date.now()/1000 - Number(ts)));
  if (s < 60) return `${s}s`; const m = Math.floor(s/60); if (m < 60) return `${m}m`;
  const h = Math.floor(m/60); return `${h}h`;
}

export async function initTodayLeaderboard() {
  lb.rows.clear();
  lb.day = Number(await contract.day());
  await backfillToday(lb.day);
  startTodayPolling(lb.day);
  renderToday();
}

async function backfillToday(dayNum) {
  try {
    const latest = await readProvider.getBlockNumber();
    const MAX_LOOKBACK = 800;
    const CHUNK        = 100;
    const fromStart    = Math.max(0, latest - MAX_LOOKBACK);

    const topic0 = ethers.id("Submitted(uint256,address,uint256,bytes32,uint256)");
    const topic1 = ethers.zeroPadValue(ethers.toBeHex(dayNum), 32);

    for (let from = fromStart; from <= latest; from += CHUNK) {
      const to = Math.min(latest, from + CHUNK - 1);
      const logs = await readProvider.getLogs({
        address: MONOMINE_ADDRESS,
        fromBlock: from,
        toBlock: to,
        topics: [topic0, topic1],
      });
      for (const log of logs) {
        const parsed = contract.interface.parseLog(log);
        const { player, fid, h, at } = parsed.args;
        upsertRow(player, fid, h, at, false);
      }
    }
    lb.lastScanned = latest;
  } catch (e) {
    console.warn("backfillToday failed:", e);
    try { lb.lastScanned = await readProvider.getBlockNumber(); } catch {}
  }
}

function startTodayPolling(dayNum) {
  stopTodayStream();
  const POLL_MS = 15000;
  const CHUNK   = 100;
  const topic0  = ethers.id("Submitted(uint256,address,uint256,bytes32,uint256)");
  const topic1  = ethers.zeroPadValue(ethers.toBeHex(dayNum), 32);

  const tick = async () => {
    try {
      const latest = await readProvider.getBlockNumber();
      let from = Math.min(lb.lastScanned + 1, latest);
      if (from > latest) return;

      while (from <= latest) {
        const to = Math.min(latest, from + CHUNK - 1);
        const logs = await readProvider.getLogs({
          address: MONOMINE_ADDRESS,
          fromBlock: from,
          toBlock: to,
          topics: [topic0, topic1],
        });
        for (const log of logs) {
          try {
            const parsed = contract.interface.parseLog(log);
            const { player, fid, h, at } = parsed.args;
            upsertRow(player, fid, h, at, true);
          } catch (e) {
            console.warn("poll parse failed:", e);
          }
        }
        lb.lastScanned = to;
        from = to + 1;
      }
    } catch {}
  };

  tick();
  const id = setInterval(tick, POLL_MS);
  lb.unsub = () => clearInterval(id);
}
function stopTodayStream() { if (lb.unsub) { try { lb.unsub(); } catch {} lb.unsub = null; } }

function upsertRow(player, fid, hash32, at, triggerRender) {
  const key = player.toLowerCase();
  const cur = lb.rows.get(key);
  const hv  = big(hash32);
  if (!cur) {
    lb.rows.set(key, { addr: player, fid: Number(fid), bestHashBig: hv, bestHash: hash32, submits: 1, at: Number(at) });
  } else {
    cur.submits += 1;
    if (hv < cur.bestHashBig || (hv === cur.bestHashBig && Number(at) < cur.at)) {
      cur.bestHashBig = hv;
      cur.bestHash    = hash32;
      cur.at          = Number(at);
    }
  }
  if (triggerRender) scheduleRender();
}
function scheduleRender() {
  if (lb.renderPending) return;
  lb.renderPending = true;
  requestAnimationFrame(() => { lb.renderPending = false; renderToday(); });
}
function renderToday() {
  const body = document.getElementById("todayTbody");
  const meta = document.getElementById("lbMeta");
  if (!body) return;

  const rows = [...lb.rows.values()].sort((a,b) => {
    if (a.bestHashBig < b.bestHashBig) return -1;
    if (a.bestHashBig > b.bestHashBig) return  1;
    return a.at - b.at;
  }).slice(0, TOP_N);

  body.innerHTML = rows.length
    ? rows.map((r, i) => `
      <tr>
        <td>${i+1}</td>
        <td><a class="link" target="_blank" href="${EXPLORER_ADDR_PREFIX}${r.addr}">${shortAddr(r.addr)}</a></td>
        <td>${r.fid}</td>
        <td><code>${r.bestHash}</code></td>
        <td>${r.submits}</td>
        <td class="muted small">${ago(r.at)} ago</td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="muted">No submissions yet today.</td></tr>`;

  if (meta) meta.textContent = `day ${lb.day} • top ${Math.min(rows.length, TOP_N)}`;
}
export async function refreshTodayIfDayChanged() {
  try {
    const d = Number(await contract.day());
    if (d !== lb.day) {
      stopTodayStream();
      await initTodayLeaderboard();
    }
  } catch {}
}

// expose writer wiring for UI module
export async function wireWriterWith(s) {
  signer   = s.signer;
  provider = s.provider;
  account  = s.account;

  // try to prime the cache, but don't crash if it fails
  try {
    if (s.chainId != null) {
      _chainIdCache = Number(s.chainId);
      _chainIdCacheAt = Date.now();
    } else if (provider) {
      await getChainIdSafe(provider);
    }
  } catch {}

  const abi = await loadAbi();
  writeContract = new ethers.Contract(MONOMINE_ADDRESS, abi, signer);
}


// ---- Submit Modal (ARIA fix) ----
function openSubmitModal(title = "Submitting…", body = "Preparing transaction…") {
  const m = document.getElementById("submitModal");
  if (!m) return;
  document.getElementById("sm_title").textContent = title;
  document.getElementById("sm_body").textContent  = body;
  document.getElementById("sm_link").innerHTML    = "";
  m.hidden = false;
  m.removeAttribute("aria-hidden");
  m.querySelector(".modal__card")?.focus();
}
function updateSubmitModal(body, linkHtml) {
  const b = document.getElementById("sm_body");
  if (b) b.textContent = body;
  if (linkHtml) {
    const l = document.getElementById("sm_link");
    if (l) l.innerHTML = linkHtml;
  }
}
function closeSubmitModal() {
  const m = document.getElementById("submitModal");
  if (!m) return;
  (document.activeElement)?.blur();  // prevent aria-hidden on focused subtree
  m.setAttribute("aria-hidden", "true");
  m.hidden = true;
}

// ---- Env probe ----
let _envProbed = false;

export async function debugEnvProbe() {
  if (_envProbed) return;
  _envProbed = true;
  try {
    const [cid, pf, rm, cd, es, pz] = await Promise.all([
      readProvider.getNetwork().then(n => n.chainId).catch(()=>null),
      contract.trustedForwarder?.().catch(()=>null),
      contract.relayManager?.().catch(()=>null),
      contract.cooldownSeconds?.().catch(()=>null),
      contract.epochSeconds?.().catch(()=>null),
      contract.paused?.().catch(()=>null),
    ]);
    const passAddr = await contract.passport().catch(()=>null);
    console.log("[MonoMine] env probe:", {
      chainId: cid, trustedForwarder: pf, relayManager: rm,
      passport: passAddr, cooldown: String(cd), epochSeconds: String(es), paused: pz
    });
  } catch (e) {
    console.log("[MonoMine] env probe failed:", e);
  }
}
