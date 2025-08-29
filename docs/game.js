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
      const html = (bestS.player === ethers.ZeroAddress)
        ? "—"
        : `<a class="link" target="_blank" href="${EXPLORER_ADDR_PREFIX}${bestS.player}">${short(bestS.player)}</a> (FID ${bestS.fid}) @ ${bestS.bestHash}`;
      leaderEl.innerHTML = html;
    }
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
  const fidHex = ethers.toBeHex(0, 32);     // 32-byte FID = 0

  // normalize bytes once, refresh if seed changes
  let localSeed = seedHex;
  let seedBytes = ethers.getBytes(localSeed);
  const fidBytes = ethers.getBytes(fidHex);

  try {
    while (mining) {
      for (let i = 0; i < BATCH && mining; i++) {
        const nonce = nextNonceHex(); // or randNonce() if you prefer random
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

      // yield to UI
      await new Promise(r => setTimeout(r, 0));

      // If seed rolled on-chain, rebind bytes
      if (seedHex !== localSeed) {
        localSeed = seedHex || (await (async () => { await refreshState(); return seedHex; })());
        if (!localSeed) break;
        seedBytes = ethers.getBytes(localSeed);
      }

      // keep the “time since last improvement” fresh
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


async function preflightSubmit(nonceHex) {
  // Cooldown gate + static call revert reason
  const [dayIdx, cd, lastAt] = await Promise.all([
    contract.day(),
    contract.cooldownSeconds(),
    contract.lastSubmitAt(await contract.day(), account ?? ethers.ZeroAddress),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const nextOk = Number(lastAt) + Number(cd);
  if (now < nextOk) {
    const left = nextOk - now;
    throw new Error(`Cooldown: wait ${left}s`);
  }

  // Dry-run to capture revert reason (ethers v6 staticCall)
  try {
    await writeContract.submit.staticCall(nonceHex);
  } catch (e) {
    // Surface common reasons
    const msg = (e?.shortMessage || e?.message || "").toLowerCase();
    if (msg.includes("passport")) throw new Error("You need a TMF Passport to submit.");
    if (msg.includes("paused"))   throw new Error("Game is paused right now.");
    throw e;
  }
}

async function submitBest() {
  if (!signer) await connect();
  const txMsg = $$("#txMsg");
  if (!best.nonce) { txMsg && (txMsg.textContent = "Mine first to get a nonce."); return; }

  try {
    // Pre-flight checks to avoid wasting a tx
    await preflightSubmit(best.nonce);
  } catch (e) {
    txMsg && (txMsg.textContent = friendlyError(e));
    return;
  }

  txMsg && (txMsg.textContent = useRelay() ? "Relaying (gasless)..." : "Submitting tx…");

  try {
    if (useRelay()) {
      const data = writeContract.interface.encodeFunctionData("submit", [best.nonce]);
      const { txHash } = await submitViaRelay(data);

      txMsg && (txMsg.innerHTML = `Relay accepted: <a href="${EXPLORER_TX_PREFIX}${txHash}" target="_blank" class="link">${short(txHash)}</a> · waiting confirm…`);

      const rec = await readProvider.waitForTransaction(txHash);
      if (txMsg) {
        txMsg.innerHTML =
          (rec && rec.status === 1)
            ? `Confirmed: <a href="${EXPLORER_TX_PREFIX}${txHash}" target="_blank" class="link">${short(txHash)}</a>`
            : `Tx failed: <a href="${EXPLORER_TX_PREFIX}${txHash}" target="_blank" class="link">${short(txHash)}</a>`;
      }
    } else {
      const tx  = await writeContract.submit(best.nonce);
      const rec = await tx.wait();
      if (txMsg) {
        txMsg.innerHTML =
          (rec && rec.status === 1)
            ? `Submitted: <a href="${EXPLORER_TX_PREFIX}${tx.hash}" target="_blank" class="link">${short(tx.hash)}</a>`
            : `Tx failed: <a href="${EXPLORER_TX_PREFIX}${tx.hash}" target="_blank" class="link">${short(tx.hash)}</a>`;
      }
    }

    await refreshState();
  } catch (e) {
    console.error(e);
    txMsg && (txMsg.textContent = ` ${friendlyError(e)}`);
  }
}




export async function submitViaRelay(calldata) {
  const body = { target: MONOMINE_ADDRESS, data: calldata, gas_limit: 300000 };

  const tryOnce = async () => {
    const res  = await fetch(RELAY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();

    if (res.ok) {
      let json; try { json = JSON.parse(text); } catch { json = {}; }
      const txHash = json.tx_hash || json.hash || json.txHash;
      if (!txHash) throw new Error(`Relay did not return tx hash: ${text.slice(0,200)}`);
      return { txHash };
    }

    const lower = text.toLowerCase();
    if (res.status === 502 && lower.includes("another transaction has higher priority")) {
      throw new Error("Another transaction has higher priority");
    }
    throw new Error(`Relay HTTP ${res.status}: ${text.slice(0,200)}`);
  };

  for (let i = 0; i < 3; i++) {
    try { return await tryOnce(); }
    catch (err) {
      const msg = (err?.message || "").toLowerCase();
      if (!msg.includes("higher priority") || i === 2) throw err;
      await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 300)));
    }
  }
}

// ---------- passport ----------
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
export function setPassportStatus(ok) {
  const el = $$("passportStatus");
  if (!el) return;
  el.innerHTML = ok
    ? `Passport: <span class="badge ok">Found</span>`
    : `Passport: <span class="badge no">Not found</span>`;
}

// expose writer wiring for UI module
export async function wireWriterWith(s) {
  signer = s.signer;
  provider = s.provider;
  account = s.account;
  const abi = await loadAbi();
  writeContract = new ethers.Contract(MONOMINE_ADDRESS, abi, signer);
}

// Extra mining telemetry
let improves = 0;
let lastImproveTs = null;

// Count leading zero bits of a 0x…32-byte hex
function leadingZeroBits(hex32) {
  // assume 0x-prefixed 64-hex chars
  const s = hex32.slice(2);
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const nib = parseInt(s[i], 16);
    if (nib === 0) { bits += 4; continue; }
    // first non-zero nibble -> + (3 - log2(nib) floor)
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
