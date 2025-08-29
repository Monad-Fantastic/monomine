// ====== CONFIG (Open Mode) ======
const MONAD_RPC = "https://testnet-rpc.monad.xyz";
const MONOMINE_ADDRESS = "0x49c52AEb95BEA2E22bede837B77C4e482840751e";
const RELAY_ENDPOINT = "https://losarchos.com/api/forward";
const PASSPORT_MINT_URL =
  "https://warpcast.com/~/compose?text=Mint%20your%20TMF%20Passport%20to%20play%20MonoMine&embeds[]=https%3A%2F%2Flosarchos.com%2Fframe";
const EXPLORER_ADDR_PREFIX = "https://testnet.monadexplorer.com/address/";
const EXPLORER_TX_PREFIX   = "https://testnet.monadexplorer.com/tx/";

// ====== Load ABI from Foundry JSON ======
async function loadAbi() {
  const j = await fetch("./contracts/MonoMine.json").then((r) => r.json());
  return j.abi || j;
}

// ====== DOM helpers ======
const $$ = (id) => document.getElementById(id);
const on = (id, handler) => { const el = $$(id); if (el) el.onclick = handler; };

function setTextEventually(id, text, tries = 20) {
  const el = document.getElementById(id);
  if (el) { el.textContent = text; return true; }
  if (tries > 0) requestAnimationFrame(() => setTextEventually(id, text, tries - 1));
  return false;
}
function enableEventually(id, enabled = true, tries = 20) {
  const el = document.getElementById(id);
  if (el) { el.disabled = !enabled; return true; }
  if (tries > 0) requestAnimationFrame(() => enableEventually(id, enabled, tries - 1));
  return false;
}
function showLinkEventually(id, href, tries = 20) {
  const el = document.getElementById(id);
  if (el) { if (href) el.href = href; el.style.display = "inline-block"; return true; }
  if (tries > 0) requestAnimationFrame(() => showLinkEventually(id, href, tries - 1));
  return false;
}

document.addEventListener("DOMContentLoaded", init);

// ====== State ======
let readProvider, provider, signer, contract, writeContract, account;
let seedHex = null;
let mining = false;
let best = { hash: null, nonce: null, value: 2n ** 256n - 1n };
let hashes = 0;
let lastTick = Date.now();

async function init() {
  console.log("MonoMine app.js v11.1 loaded");
  const abi = await loadAbi();
  readProvider = new ethers.JsonRpcProvider(MONAD_RPC);
  contract = new ethers.Contract(MONOMINE_ADDRESS, abi, readProvider);

  // Bind UI
  on("connectBtn", connect);
  on("mineBtn", toggleMine);
  on("submitBtn", submitBest);
  on("shareBtn", shareCast);
  on("rollBtn", rollIfNeeded);
  on("mintBtn", () => window.open(PASSPORT_MINT_URL, "_blank"));
  on("mintBtn2", () => window.open(PASSPORT_MINT_URL, "_blank"));
  on("addNetworkBtn", addMonadNetwork);
  const infoLink = $$("#whatIsPassport"); if (infoLink) infoLink.href = PASSPORT_MINT_URL;
  const viewAddr = $$("#viewAddr"); if (viewAddr) viewAddr.style.display = "none";

    if (window.ethereum) {
    window.ethereum.removeAllListeners?.("accountsChanged");
    window.ethereum.on?.("accountsChanged", async (accs) => {
      if (!accs || accs.length === 0) {
        setTextEventually("status", "Not connected");
        setPassportStatus(false);
        enableEventually("mineBtn", false);
        enableEventually("submitBtn", false);
        return;
      }
      await connectSilent();     // rehydrate signer + badge
      await refreshState();
    });

    window.ethereum.removeAllListeners?.("chainChanged");
    window.ethereum.on?.("chainChanged", () => window.location.reload());
  }

  await connectSilent();


  // Relay health ping
  try {
    const healthUrl = RELAY_ENDPOINT.replace("/api/forward", "/health");
    const ping = await fetch(healthUrl, { mode: "cors" });
    const ok = ping.ok && (await ping.text()).trim().toUpperCase().includes("OK");
    const st = $$("#status");
    if (st && !st.textContent.includes("Connected:")) {
      st.textContent = `${st.textContent || "Status"} • Relay ${ok ? "online" : "offline"}`;
    }
  } catch {
    const st = $$("#status");
    if (st && !st.textContent.includes("Connected:")) {
      st.textContent = `${st.textContent || "Status"} • Relay offline`;
    }
  }

  await refreshState();
  setInterval(updateRate, 1000);
  setInterval(refreshState, 20000);
}

async function connect() {
  try {
    setTextEventually("status", "Requesting wallet…");

    if (!window.ethereum) {
      setTextEventually("status", "No wallet found (install MetaMask or use Passport).");
      return;
    }

    provider = new ethers.BrowserProvider(window.ethereum, "any");
    const accounts = await provider.send("eth_requestAccounts", []);
    if (!accounts || accounts.length === 0) {
      setTextEventually("status", "No account authorized.");
      return;
    }

    signer  = await provider.getSigner();
    account = await signer.getAddress();

    // 🔽 ADD THIS BLOCK HERE
    try {
      const net = await provider.getNetwork();
      if (Number(net.chainId) !== 10143) {
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x279F" }], // 10143
          });
        } catch (err) {
          // Chain not added yet → add and switch
          if (err?.code === 4902) {
            await addMonadNetwork();
            await window.ethereum.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: "0x279F" }],
            });
          }
        }
      }
    } catch (e) { /* non-fatal */ }
    // 🔼 END INSERT

    const abi = await loadAbi();
    writeContract = new ethers.Contract(MONOMINE_ADDRESS, abi, signer);

    setTextEventually("status", `Connected: ${short(account)}`);
    enableEventually("mineBtn", true);
    enableEventually("submitBtn", true);
    showLinkEventually("viewAddr", EXPLORER_ADDR_PREFIX + account);

    // (listeners etc…)
  } catch (e) {
    console.error("Connect error:", e);
    setTextEventually("status", `Connect failed: ${e.shortMessage || e.message}`);
  }
}


async function connectSilent() {
  if (!window.ethereum) return;

  try {
    // Do not prompt — just read existing authorized accounts
    const provider0 = new ethers.BrowserProvider(window.ethereum, "any");
    const accounts = await window.ethereum.request({ method: "eth_accounts" });

    if (!accounts || accounts.length === 0) {
      setTextEventually("status", "Not connected • Relay checking…");
      setPassportStatus(false);
      return;
    }

    provider = provider0;
    signer  = await provider.getSigner();
    account = await signer.getAddress();

    const abi = await loadAbi();
    writeContract = new ethers.Contract(MONOMINE_ADDRESS, abi, signer);

    setTextEventually("status", `Connected: ${short(account)}`);
    enableEventually("mineBtn",   true);
    enableEventually("submitBtn", true);
    showLinkEventually("viewAddr", EXPLORER_ADDR_PREFIX + account);

    // Update Passport badge
    try {
      const ok = await hasPassport(account);
      setPassportStatus(ok);
    } catch {}
  } catch (e) {
    console.warn("connectSilent failed:", e);
  }
}

async function addMonadNetwork() {
  if (!window.ethereum) return;
  try {
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: "0x279F", // 10143
        chainName: "Monad Testnet",
        rpcUrls: ["https://testnet-rpc.monad.xyz"],
        nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
        blockExplorerUrls: ["https://testnet.monadexplorer.com/"]
      }]
    });
  } catch (e) {
    console.warn("addMonadNetwork failed:", e);
  }
}


function short(addr) {
  return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "—";
}

async function refreshState() {
  try {
    const day = await contract.day();
    const seed = await contract.seed();
    const bestS = await contract.bestOfDay(day);
    seedHex = seed;
    setTextEventually("day", day.toString());
    setTextEventually("seed", seedHex);
    const leaderEl = $$("#leader");
    if (leaderEl) {
      const leaderStr =
        bestS.player === ethers.ZeroAddress
          ? "—"
          : `<a class="link" target="_blank" href="${EXPLORER_ADDR_PREFIX}${bestS.player}">${short(bestS.player)}</a> (FID ${bestS.fid}) @ ${bestS.bestHash}`;
      leaderEl.innerHTML = leaderStr;
    }
  } catch (e) { console.error(e); }
}

async function rollIfNeeded() {
  try {
    if (!signer) await connect();
    setTextEventually("rollMsg", "Rolling if needed…");
    const tx = await writeContract.rollIfNeeded();
    await tx.wait();
    setTextEventually("rollMsg", " Done");
    await refreshState();
  } catch (e) {
    setTextEventually("rollMsg", e.shortMessage || e.message);
  }
}

function randNonce() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function toggleMine() {
  if (!seedHex) { await refreshState(); if (!seedHex) return; }
  mining = !mining;
  setTextEventually("mineBtn", mining ? "Stop Mining" : "Start Mining");
  if (mining) mineLoop();
}
async function mineLoop() {
  while (mining) {
    const nonce = randNonce();
    const h = ethers.keccak256(ethers.concat([seedHex, ethers.zeroPadValue(0, 32), nonce]));
    const hv = BigInt(h);
    hashes++;
    if (hv < best.value) {
      best = { hash: h, nonce, value: hv };
      setTextEventually("bestHash", best.hash);
      setTextEventually("bestNonce", best.nonce);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}
function updateRate() {
  const rateEl = $$("#rate"); if (!rateEl) return;
  if (typeof lastTick !== "number") lastTick = Date.now();
  const now = Date.now(), dt = (now - lastTick) / 1000;
  if (dt >= 0.95) {
    rateEl.textContent = `hashes/s: ${Math.round(hashes / dt)}`;
    hashes = 0; lastTick = now;
  }
}

const useRelayEl = $$("#useRelay");
const useRelay = () => (useRelayEl ? useRelayEl.checked : true);

async function submitBest() {
  if (!signer) await connect();
  if (!best.nonce) { setTextEventually("txMsg", "Mine first to get a nonce."); return; }

  // Check passport first
  const ok = await hasPassport(account);
  if (!ok) {
    setTextEventually("txMsg", "No Passport found — please Mint first.");
    return;
  }

  setTextEventually("txMsg", useRelay() ? "Relaying (gasless)..." : "Submitting tx…");
  try {
    if (useRelay()) {
      const data = writeContract.interface.encodeFunctionData("submit", [best.nonce]);
      const res = await submitViaRelay(data);
      if (res && res.txHash) {
        setTextEventually("txMsg", `Relay accepted: ${short(res.txHash)}`);
      } else {
        setTextEventually("txMsg", `Relay accepted: ${JSON.stringify(res).slice(0, 120)}…`);
      }
    } else {
      const tx = await writeContract.submit(best.nonce);
      setTextEventually("txMsg", `Submitting… ${tx.hash}`);
      await tx.wait();
      setTextEventually("txMsg", `Submitted: ${short(tx.hash)}`);
    }
    await refreshState();
  } catch (e) {
    console.error(e);
    setTextEventually("txMsg", friendlyError(e));
  }
}

// Relay forwarder (Open Mode)
async function submitViaRelay(calldata) {
  const body = { target: MONOMINE_ADDRESS, data: calldata, gas_limit: 300000 };
  const res = await fetch(RELAY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Relay HTTP ${res.status}: ${text.slice(0,200)}`);
  let json; try { json = JSON.parse(text); } catch { json = {}; }
  const txHash = json.tx_hash || json.hash || json.txHash;
  return txHash ? { txHash } : json;
}

function friendlyError(e) {
  const m = (e?.message || "").toLowerCase();
  if (m.includes("gas_limit too high")) return "Relay cap hit: try again or submit directly.";
  if (m.includes("quota")) return "Out of free relay quota today.";
  if (m.includes("passport")) return "You need a TMF Passport to submit.";
  return e?.shortMessage || e?.message || String(e);
}

function shareCast() {
  const text = encodeURIComponent(`Mining MonoMine on Monad testnet. Best hash: ${best.hash || "—"} • Try it:`);
  window.open(`https://warpcast.com/~/compose?text=${text}`, "_blank");
}

// ===== Passport helpers =====
async function hasPassport(addr) {
  try {
    const passAddr = await contract.passport();
    if (!passAddr || passAddr === ethers.ZeroAddress) return false;
    const erc721Abi = ["function balanceOf(address) view returns (uint256)"];
    const pass = new ethers.Contract(passAddr, erc721Abi, readProvider);
    const bal = await pass.balanceOf(addr);
    return (bal && BigInt(bal) > 0n);
  } catch (e) { console.warn("Passport check failed:", e); return false; }
}
function setPassportStatus(ok) {
  const el = document.getElementById("passportStatus");
  if (!el) return;
  el.innerHTML = ok
    ? `Passport: <span class="badge ok">Found</span>`
    : `Passport: <span class="badge no">Not found</span>`;
}
