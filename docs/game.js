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




// --- helpers used by preflight ------------------------------------------------
async function getCooldownRemaining(addr) {
  try {
    const [day, cd, last] = await Promise.all([
      contract.day(),
      contract.cooldownSeconds(),
      contract.lastSubmitAt(await contract.day(), addr),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const remain = Number(cd) - Math.max(0, now - Number(last));
    return remain > 0 ? remain : 0;
  } catch (_) { return 0; }
}

async function isPaused() {
  try { return await contract.paused(); } catch { return false; }
}

function shortHash(h) { return h ? `${h.slice(0,6)}…${h.slice(-4)}` : "—"; }

function decodeRpcError(e) {
  const raw = e?.data?.message || e?.shortMessage || e?.message || String(e);
  const m = raw.toLowerCase();
  if (m.includes("another transaction has higher priority")) return "Network busy: another tx has priority. Try again.";
  if (m.includes("user rejected")) return "Transaction rejected in wallet.";
  if (m.includes("nonce too low")) return "Wallet nonce too low; wait a moment and retry.";
  if (m.includes("insufficient funds")) return "Not enough MON for gas.";
  if (m.includes("execution reverted")) return "Reverted by contract (cooldown/passport/paused).";
  return raw;
}

// --- submit path --------------------------------------------------------------

async function preflightSubmit(addr) {
  // 1) chain check
  try {
    if (!provider) throw new Error("No provider");
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== 10143) {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x279F" }], // Monad testnet
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

  // 2) app/contract state
  if (await isPaused()) {
    throw new Error("Game is currently paused.");
  }

  // 3) passport
  const has = await hasPassport(addr);
  if (!has) {
    throw new Error("Passport not found — mint a TMF Passport first.");
  }

  // 4) cooldown
  const left = await getCooldownRemaining(addr);
  if (left > 0) {
    throw new Error(`Cooldown active: wait ${left}s.`);
  }
}

export async function submitBest() {
  const txMsg = document.getElementById("txMsg");
  const put = (t) => { if (txMsg) txMsg.textContent = t; };

  if (!signer) await connect();
  if (!best.nonce) { put("Mine first to get a nonce."); return; }

  try {
    await preflightSubmit(account);
  } catch (why) {
    put(String(why.message || why));
    return;
  }

  try {
    if (useRelay()) {
      put("Relaying (gasless)...");
      const data = writeContract.interface.encodeFunctionData("submit", [best.nonce]);
      const { txHash } = await submitViaRelay(data);
      if (txMsg) {
        txMsg.innerHTML = `Relay accepted: <a href="${EXPLORER_TX_PREFIX}${txHash}" target="_blank" class="link">${shortHash(txHash)}</a> · waiting confirm…`;
      }
      const rec = await readProvider.waitForTransaction(txHash);
      if (txMsg) {
        txMsg.innerHTML = (rec && rec.status === 1)
          ? `Confirmed: <a href="${EXPLORER_TX_PREFIX}${txHash}" target="_blank" class="link">${shortHash(txHash)}</a>`
          : `Tx failed: <a href="${EXPLORER_TX_PREFIX}${txHash}" target="_blank" class="link">${shortHash(txHash)}</a>`;
      }
    } else {
      put("Submitting tx…");
      // give the node a concrete gas estimate; if estimate fails it will throw here (and we’ll surface a useful error)
      const gas = await writeContract.submit.estimateGas(best.nonce);
      const tx  = await writeContract.submit(best.nonce, { gasLimit: gas });
      if (txMsg) txMsg.textContent = `Submitting… ${tx.hash}`;
      const rec = await tx.wait();
      if (txMsg) {
        txMsg.innerHTML = (rec && rec.status === 1)
          ? `Submitted: <a href="${EXPLORER_TX_PREFIX}${tx.hash}" target="_blank" class="link">${shortHash(tx.hash)}</a>`
          : `Tx failed: <a href="${EXPLORER_TX_PREFIX}${tx.hash}" target="_blank" class="link">${shortHash(tx.hash)}</a>`;
      }
    }

    await refreshState();
  } catch (e) {
    console.error("submitBest error:", e);
    put(decodeRpcError(e));
  }
}

// Keep the jittered retry for the prioritization edge-case you saw (502/-32603).
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
      if (!isPriority || i === retries) throw err;
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
