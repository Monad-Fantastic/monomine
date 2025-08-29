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
  console.log("MonoMine app.js v11.5 loaded");
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
  on("tmfInfoBtn", openTmfModal);
  on("tmfClose", closeTmfModal);
  // click on scrim closes
  document.addEventListener("click", (e) => {
    const m = $$("#tmfModal");
    if (!m || m.hidden) return;
    if (e.target && e.target.getAttribute("data-close") === "1") closeTmfModal();
  });


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
  
  await refreshWalletUI();
setInterval(refreshWalletUI, 15000);

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


    const abi = await loadAbi();
    writeContract = new ethers.Contract(MONOMINE_ADDRESS, abi, signer);

    setTextEventually("status", `Connected: ${short(account)}`);
    enableEventually("mineBtn", true);
    enableEventually("submitBtn", true);
    showLinkEventually("viewAddr", EXPLORER_ADDR_PREFIX + account);

    await refreshWalletUI();

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

    await refreshWalletUI();

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
    const fid = ethers.toBeHex(0, 32); // 0 as a 32-byte hex
    const h = ethers.keccak256(ethers.concat([seedHex, fid, nonce]));
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
  if (!best.nonce) {
    const el = $$("#txMsg");
    if (el) el.textContent = "Mine first to get a nonce.";
    return;
  }

  const txMsg = $$("#txMsg");
  if (txMsg) txMsg.textContent = useRelay() ? "Relaying (gasless)..." : "Submitting tx…";

  try {
    if (useRelay()) {
      // Gasless via TMF Gas Station (Open Mode)
      const data = writeContract.interface.encodeFunctionData("submit", [best.nonce]);
      const { txHash } = await submitViaRelay(data);

      if (txMsg) {
        txMsg.innerHTML = `Relay accepted: <a href="${EXPLORER_TX_PREFIX}${txHash}" target="_blank" class="link">${short(txHash)}</a> · waiting confirm…`;
      }

      // wait for 1 confirmation via READ provider
      const rec = await readProvider.waitForTransaction(txHash);
      if (txMsg) {
        if (rec && rec.status === 1) {
          txMsg.innerHTML = `Confirmed: <a href="${EXPLORER_TX_PREFIX}${txHash}" target="_blank" class="link">${short(txHash)}</a>`;
        } else {
          txMsg.innerHTML = `Tx failed: <a href="${EXPLORER_TX_PREFIX}${txHash}" target="_blank" class="link">${short(txHash)}</a>`;
        }
      }
    } else {
      // Direct on-chain
      const tx = await writeContract.submit(best.nonce);
      if (txMsg) txMsg.textContent = `Submitting… ${tx.hash}`;
      const rec = await tx.wait();
      if (txMsg) {
        if (rec && rec.status === 1) {
          txMsg.innerHTML = `Submitted: <a href="${EXPLORER_TX_PREFIX}${tx.hash}" target="_blank" class="link">${short(tx.hash)}</a>`;
        } else {
          txMsg.innerHTML = `Tx failed: <a href="${EXPLORER_TX_PREFIX}${tx.hash}" target="_blank" class="link">${short(tx.hash)}</a>`;
        }
      }
    }

    await refreshState();
  } catch (e) {
    console.error(e);
    if (txMsg) txMsg.textContent = ` ${friendlyError(e)}`;
  }
}


// Relay forwarder (Open Mode)
async function submitViaRelay(calldata) {
  const body = { target: MONOMINE_ADDRESS, data: calldata, gas_limit: 300000 };
  const res = await fetch(RELAY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" }, // Open Mode: no X-TMF-Key from browser
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Relay HTTP ${res.status}: ${text.slice(0, 200)}`);

  let json;
  try { json = JSON.parse(text); } catch { json = {}; }

  const txHash = json.tx_hash || json.hash || json.txHash;
  if (!txHash) throw new Error(`Relay did not return tx hash: ${text.slice(0, 200)}`);
  return { txHash };
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

async function refreshWalletUI() {
  const connectBtn = $$("#connectBtn");
  const addNetBtn  = $$("#addNetworkBtn");
  const mintBtn    = $$("#mintBtn");

  // Figure out current wallet + network status
  let connected = !!account;
  let onMonad = false;

  try {
    if (!connected && window.ethereum) {
      const eth  = new ethers.BrowserProvider(window.ethereum, "any");
      const accs = await eth.send("eth_accounts", []);
      if (accs && accs.length) {
        provider = eth;
        signer   = await provider.getSigner();
        account  = await signer.getAddress();
        connected = true;
      }
    }
  } catch {}

  try {
    if (provider) {
      const net = await provider.getNetwork();
      onMonad = Number(net.chainId) === 10143;
    }
  } catch {}

  // Passport
  const passOk = connected ? await hasPassport(account) : false;
  setPassportStatus(passOk);

  // Toggle buttons
  if (connectBtn) connectBtn.disabled = connected;
  if (addNetBtn)  addNetBtn.disabled  = !connected || onMonad;
  if (mintBtn) {
    mintBtn.disabled   = passOk;
    mintBtn.textContent = passOk ? "Passport Minted" : "Mint Passport";
  }

  // Explorer link
  showLinkEventually("viewAddr", connected ? (EXPLORER_ADDR_PREFIX + account) : "", 1);
}



function openTmfModal() {
  const modal = $$("#tmfModal");
  if (!modal) return;
  modal.hidden = false;
  const card = modal.querySelector(".modal__card");
  card?.focus();
  // close on ESC
  const onEsc = (e) => { if (e.key === "Escape") closeTmfModal(); };
  modal.dataset.esc = "1";
  document.addEventListener("keydown", onEsc, { once: true });
  modal._escHandler = onEsc;
}
function closeTmfModal() {
  const modal = $$("#tmfModal");
  if (!modal) return;
  modal.hidden = true;
  if (modal._escHandler) {
    document.removeEventListener("keydown", modal._escHandler);
    delete modal._escHandler;
  }
}

// In init(