// game.js — mining + submit + read-only state

export const MONAD_RPC = "https://testnet-rpc.monad.xyz";
export const MONOMINE_ADDRESS = "0x49c52AEb95BEA2E22bede837B77C4e482840751e";
export const RELAY_ENDPOINT = "https://losarchos.com/api/forward";
export const EXPLORER_ADDR_PREFIX = "https://testnet.monadexplorer.com/address/";
export const EXPLORER_TX_PREFIX   = "https://testnet.monadexplorer.com/tx/";
export const PASSPORT_MINT_URL =
  "https://warpcast.com/~/compose?text=Mint%20your%20TMF%20Passport%20to%20play%20MonoMine&embeds[]=https%3A%2F%2Flosarchos.com%2Fframe";

export const $$ = (id) => document.getElementById(id);

export let readProvider, provider, signer, contract, writeContract, account;
export let seedHex = null;
export let mining = false;
export let best = { hash: null, nonce: null, value: 2n ** 256n - 1n };
export let hashes = 0;
export let lastTick = Date.now();

import { ethers } from "https://esm.sh/ethers@6.13.2";

function log(...args){ console.log("[MonoMine]", ...args); }
function shortHash(h){ return h ? `${h.slice(0,6)}…${h.slice(-4)}` : "—"; }

// --- cached chainId to cut RPC spam ---
let cachedChainId = null;
async function ensureNetwork() {
  if (!provider) throw new Error("No provider");
  if (cachedChainId == null) {
    const net = await provider.getNetwork();       // 1 RPC once per (re)wire
    cachedChainId = Number(net.chainId);
  }
  return cachedChainId;
}

// ---------- ABI / DOM helpers ----------
export async function loadAbi() {
  const j = await fetch("./contracts/MonoMine.json").then(r => r.json());
  return j.abi || j;
}
export function short(addr) {
  return addr ? addr.slice(0,6) + "…" + addr.slice(-4) : "—";
}
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

// ---------- contract state (read) ----------
export async function initGame() {
  const abi = await loadAbi();
  readProvider = new ethers.JsonRpcProvider(MONAD_RPC);
  contract = new ethers.Contract(MONOMINE_ADDRESS, abi, readProvider);
  await initTodayLeaderboard();
}

// close button for submit modal
document.getElementById("sm_close")?.addEventListener("click", () => closeSubmitModal());

export async function refreshState() {
  try {
    const day  = await contract.day(); // 1 call
    const [seed, bestS] = await Promise.all([
      contract.seed(),                // 1 call
      contract.bestOfDay(day),        // 1 call
    ]);
    seedHex = seed;

    setTextEventually("day",  day.toString());
    setTextEventually("seed", seedHex);

    const leaderEl = $$("leader");
    if (leaderEl) {
      const html = (bestS.player === ethers.ZeroAddress)
        ? "—"
        : `<a class="link" target="_blank" href="${EXPLORER_ADDR_PREFIX}${bestS.player}">${short(bestS.player)}</a> (FID ${bestS.fid}) @ ${bestS.bestHash}`;
      leaderEl.innerHTML = html;
    }

    await refreshTodayIfDayChanged();
  } catch (e) {
    console.error(e);
  }
}

// ---------- mining ----------
function randNonce() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "0x" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

export async function toggleMine() {
  if (!seedHex) { await refreshState(); if (!seedHex) return; }
  mining = !mining;
  setTextEventually("mineBtn", mining ? "Stop Mining" : "Start Mining");
  if (mining) void mineLoop();
}

async function mineLoop() {
  const BATCH = 2048;
  const fidHex = ethers.toBeHex(0, 32); // 32-byte FID = 0

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

// ---------- submit ----------
const useRelayEl = $$("useRelay");
export const useRelay = () => (useRelayEl ? useRelayEl.checked : true);

export function friendlyError(e) {
  const m = (e?.message || "").toLowerCase();
  if (m.includes("gas_limit too high")) return "Relay cap hit: try again or submit directly.";
  if (m.includes("quota"))              return "Out of free relay quota today.";
  if (m.includes("passport"))           return "You need a TMF Passport to submit.";
  if (m.includes("higher priority"))    return "Network busy — retrying…";
  return e?.shortMessage || e?.message || String(e);
}

// --- helpers used by preflight (throttled) ---
async function getCooldownRemaining(addr) {
  try {
    const day = await contract.day(); // 1 call
    const [cd, last] = await Promise.all([
      contract.cooldownSeconds(),     // 1 call
      contract.lastSubmitAt(day, addr) // 1 call
    ]);
    const now = Math.floor(Date.now() / 1000);
    const remain = Number(cd) - Math.max(0, now - Number(last));
    return remain > 0 ? remain : 0;
  } catch (_) { return 0; }
}
async function isPaused() {
  try { return await contract.paused(); } catch { return false; }
}
async function getFid(addr) {
  try {
    const passAddr = await contract.passport();
    if (!passAddr || passAddr === ethers.ZeroAddress) return 0n;
    const ipAbi = ["function fidOf(address) view returns (uint256)"];
    const pass = new ethers.Contract(passAddr, ipAbi, readProvider);
    const fid = await pass.fidOf(addr);
    return BigInt(fid || 0);
  } catch { return 0n; }
}





// ---------- passport (with 60s cache; report both NFT + FID) ----------
const passportCache = new Map(); // addr -> { ts, hasNft, fid }

async function getPassportContract() {
  try {
    const passAddr = await contract.passport();
    if (!passAddr || passAddr === ethers.ZeroAddress) return null;
    const abi = [
      "function balanceOf(address) view returns (uint256)",
      "function fidOf(address) view returns (uint256)"
    ];
    return new ethers.Contract(passAddr, abi, readProvider);
  } catch { return null; }
}

export async function getPassportStatus(addr) {
  const key = addr?.toLowerCase?.();
  const now = Date.now();
  const cached = key ? passportCache.get(key) : null;
  if (cached && (now - cached.ts) < 60_000) return cached;

  const res = { ts: now, hasNft: false, fid: 0n };
  try {
    const pass = await getPassportContract();
    if (!pass) {
      if (key) passportCache.set(key, res);
      return res;
    }
    const [bal, fid] = await Promise.all([
      pass.balanceOf(addr).catch(()=>0n),
      pass.fidOf(addr).catch(()=>0n),
    ]);
    res.hasNft = (bal && BigInt(bal) > 0n);
    res.fid    = BigInt(fid || 0n);
    if (key) passportCache.set(key, res);
    return res;
  } catch {
    if (key) passportCache.set(key, res);
    return res;
  }
}

// back-compat helpers (kept name so other code doesn’t break)
export async function hasPassport(addr) {
  const s = await getPassportStatus(addr);
  return s.fid !== 0n; // gate by fid (not by NFT)
}

export function setPassportStatus(okOrObj) {
  const el = $$("passportStatus"); if (!el) return;
  const s = (typeof okOrObj === "object") ? okOrObj : { hasNft: !!okOrObj, fid: okOrObj ? 1n : 0n };
  // UI shows both signals so users understand what’s wrong
  if (s.fid !== 0n) {
    el.innerHTML = `Passport: <span class="badge ok">Linked (FID ${s.fid})</span>`;
  } else if (s.hasNft) {
    el.innerHTML = `Passport: <span class="badge no">NFT only (no FID)</span>`;
  } else {
    el.innerHTML = `Passport: <span class="badge no">Not found</span>`;
  }
}





// --- submit path --------------------------------------------------------------
async function preflightSubmit(addr) {
  log("preflight: begin", { addr });

  // 1) network (cached)
  const id = await ensureNetwork();
  log("preflight: network", id);
  if (id !== 10143) throw new Error("Please switch to Monad Testnet (10143).");

  // 2) paused
  const paused = await isPaused();
  log("preflight: paused?", paused);
  if (paused) throw new Error("Game is currently paused.");

  // 3) passport status
  const ps = await getPassportStatus(addr);
  log("preflight: passport?", { hasNft: ps.hasNft, fid: String(ps.fid) });
  setPassportStatus(ps); // keep UI consistent
  if (ps.fid === 0n) {
    const hint = ps.hasNft
      ? "Your wallet holds the Passport NFT but it isn’t linked to a Farcaster ID (fid=0). Re-link or mint via Monad Games ID."
      : "Passport not found — mint a TMF Passport first.";
    throw new Error(hint);
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
      // ⚠️ Skip simulation for relay (msg.sender differs under 2771)
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
      // Direct wallet path — safe to simulate
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

// Relay with jittered retry
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


// expose writer wiring for UI module
export async function wireWriterWith(s) {
  signer   = s.signer;
  provider = s.provider;
  account  = s.account;
  cachedChainId = null; // reset network cache on rewire
  const abi = await loadAbi();
  writeContract = new ethers.Contract(MONOMINE_ADDRESS, abi, signer);
}

// Extra mining telemetry
let improves = 0;
let lastImproveTs = null;

// Count leading zero bits of a 0x…32-byte hex
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
let nonceCounter = 1n;
function nextNonceHex() {
  const h = nonceCounter.toString(16).padStart(64, "0");
  nonceCounter += 1n;
  return "0x" + h;
}
function reseedNonceCounter() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let seed = 0n;
  for (let i = 0; i < 8; i++) seed = (seed << 8n) | BigInt(b[i]);
  if (seed === 0n) seed = 1n;
  nonceCounter = (nonceCounter + seed) & ((1n << 256n) - 1n);
}

// ===== Today Leaderboard (polling; RPC friendly) =====
const TOP_N = 50; // huge 🙂

let lb = {
  day: null,
  rows: new Map(),     // addr -> { addr, fid, bestHashBig, bestHash, submits, at }
  unsub: null,         // clearInterval handle
  renderPending: false,
  lastScanned: 0,      // last block we processed
};

function big(h){ try { return BigInt(h); } catch { return (1n<<256n)-1n; } }
function shortAddr(a){ return a ? a.slice(0,6)+"…"+a.slice(-4) : "—"; }
function ago(ts){
  const s = Math.max(0, Math.floor(Date.now()/1000 - Number(ts)));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s/60); if (m < 60) return `${m}m`;
  const h = Math.floor(m/60); return `${h}h`;
}

export async function initTodayLeaderboard() {
  lb.rows.clear();
  const curDay = await contract.day();
  lb.day = Number(curDay);
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

    const topic0 = submittedTopic();
    const topic1 = dayTopic(dayNum);

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
        upsertRow(player, fid, h, at, /*triggerRender*/ false);
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

  const POLL_MS = 10_000;
  const CHUNK   = 100;
  const topic0  = submittedTopic();
  const topic1  = dayTopic(dayNum);

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
            upsertRow(player, fid, h, at, /*triggerRender*/ true);
          } catch (e) {
            console.warn("poll parse failed:", e);
          }
        }

        lb.lastScanned = to;
        from = to + 1;
      }
    } catch (e) {
      // swallow transient RPC hiccups
    }
  };

  tick();
  const id = setInterval(tick, POLL_MS);
  lb.unsub = () => clearInterval(id);
}

function stopTodayStream() {
  if (lb.unsub) { try { lb.unsub(); } catch {} lb.unsub = null; }
}

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

const SUBMITTED_SIG = "Submitted(uint256,address,uint256,bytes32,uint256)";
function submittedTopic() { return ethers.id(SUBMITTED_SIG); }
function dayTopic(dayNum)  { return ethers.zeroPadValue(ethers.toBeHex(dayNum), 32); }

// ---------- submit modal helpers ----------
function openSubmitModal(title = "Submitting…", body = "Preparing transaction…") {
  const m = document.getElementById("submitModal");
  if (!m) return;
  document.getElementById("sm_title").textContent = title;
  document.getElementById("sm_body").textContent  = body;
  document.getElementById("sm_link").innerHTML    = "";
  m.hidden = false;
  m.removeAttribute("aria-hidden"); // avoid aria-hidden on focused subtree
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
  m.setAttribute("aria-hidden", "true");
  m.hidden = true;
}

// Explain a failure with concrete details
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

function decodeRpcErrorVerbose(e) {
  const basic =
    (e?.shortMessage) ||
    (e?.info?.error?.message) ||
    (e?.data?.message) ||
    (e?.message) ||
    String(e);

  const m = (basic || "").toLowerCase();
  if (m.includes("gas_limit too high"))  return "Relay cap hit: try again or submit directly. (" + basic + ")";
  if (m.includes("quota"))               return "Out of free relay quota today. (" + basic + ")";
  if (m.includes("passport"))            return "You need a TMF Passport to submit. (" + basic + ")";
  if (m.includes("higher priority"))     return "Network busy — retrying… (" + basic + ")";
  if (m.includes("user rejected"))       return "Transaction rejected in wallet.";
  if (m.includes("insufficient funds"))  return "Not enough MON for gas.";
  if (m.includes("execution reverted"))  return "Reverted by contract (cooldown/passport/paused). (" + basic + ")";
  return basic;
}

// Handy one-click probe (call from console if needed)
export async function debugEnvProbe() {
  try {
    const [cid, pf, rm, cd, es, paused] = await Promise.all([
      readProvider.getNetwork().then(n => n.chainId).catch(()=>null),
      contract.trustedForwarder?.().catch(()=>null),
      contract.relayManager?.().catch(()=>null),
      contract.cooldownSeconds?.().catch(()=>null),
      contract.epochSeconds?.().catch(()=>null),
      contract.paused?.().catch(()=>null),
    ]);
    const passAddr = await contract.passport().catch(()=>null);
    log("env probe:", { chainId: cid, trustedForwarder: pf, relayManager: rm, passport: passAddr, cooldown: String(cd), epochSeconds: String(es), paused });
  } catch (e) {
    log("env probe failed:", e);
  }
}
