// ui.js — wallet, network, buttons, modal; wires into game.js

import {
  MONAD_RPC, MONOMINE_ADDRESS, RELAY_ENDPOINT,
  EXPLORER_ADDR_PREFIX, EXPLORER_TX_PREFIX,
  $$, loadAbi, short,
  initGame, refreshState,
  provider, signer, account, readProvider,
  setTextEventually, enableEventually, showLinkEventually,
  hasPassport, setPassportStatus,
  toggleMine, updateRate, submitBest,
} from "./game.js";

let _provider, _signer, _account, writeContract;

document.addEventListener("DOMContentLoaded", initUI);

async function initUI() {
  console.log("MonoMine ui.js loaded");
  await initGame();

  on("connectBtn", connect);
  on("mineBtn",    toggleMine);
  on("submitBtn",  submitBest);
  on("rollBtn",    rollIfNeeded);
  on("mintBtn",    () => window.open(PASSPORT_MINT_URL, "_blank"));
  on("mintBtn2",   () => window.open(PASSPORT_MINT_URL, "_blank"));
  on("addNetworkBtn", addMonadNetwork);
  on("shareBtn",   shareCast);
  on("tmfInfoBtn", openTmfModal);
  on("tmfClose",   closeTmfModal);
  document.addEventListener("click", (e) => {
    const m = $$("#tmfModal");
    if (!m || m.hidden) return;
    if (e.target && e.target.getAttribute("data-close") === "1") closeTmfModal();
  });

  const infoLink = $$("#whatIsPassport"); if (infoLink) infoLink.href = PASSPORT_MINT_URL;
  const viewAddr = $$("#viewAddr");       if (viewAddr) viewAddr.style.display = "none";

  // wallet events
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
      await connectSilent();
      await refreshState();
      await refreshWalletUI();
    });
    window.ethereum.removeAllListeners?.("chainChanged");
    window.ethereum.on?.("chainChanged", () => window.location.reload());
  }

  await connectSilent();

  // relay health
  pingRelay();

  await refreshState();
  setInterval(updateRate, 1000);
  setInterval(refreshState, 20000);
  await refreshWalletUI();
  setInterval(refreshWalletUI, 15000);
}

function on(id, handler) {
  const el = $$(id);
  if (el) el.onclick = handler;
}

async function pingRelay() {
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
}

async function connect() {
  try {
    setTextEventually("status", "Requesting wallet…");
    if (!window.ethereum) {
      setTextEventually("status", "No wallet found (install MetaMask or use Passport).");
      return;
    }

    _provider = new ethers.BrowserProvider(window.ethereum, "any");
    const accounts = await _provider.send("eth_requestAccounts", []);
    if (!accounts || accounts.length === 0) {
      setTextEventually("status", "No account authorized.");
      return;
    }
    _signer  = await _provider.getSigner();
    _account = await _signer.getAddress();

    // ensure network
    try {
      const net = await _provider.getNetwork();
      if (Number(net.chainId) !== 10143) {
        try {
          await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279F" }] });
        } catch (err) {
          if (err?.code === 4902) {
            await addMonadNetwork();
            await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279F" }] });
          }
        }
      }
    } catch {}

    const abi = await loadAbi();
    writeContract = new ethers.Contract(MONOMINE_ADDRESS, abi, _signer);

    setTextEventually("status", `Connected: ${short(_account)}`);
    enableEventually("mineBtn", true);
    enableEventually("submitBtn", true);
    showLinkEventually("viewAddr", `${EXPLORER_ADDR_PREFIX}${_account}`);

    await refreshWalletUI();
  } catch (e) {
    console.error("Connect error:", e);
    setTextEventually("status", `Connect failed: ${e.shortMessage || e.message}`);
  }
}

async function connectSilent() {
  if (!window.ethereum) return;
  try {
    const p0 = new ethers.BrowserProvider(window.ethereum, "any");
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    if (!accounts || accounts.length === 0) {
      setTextEventually("status", "Not connected • Relay checking…");
      setPassportStatus(false);
      return;
    }
    _provider = p0;
    _signer   = await _provider.getSigner();
    _account  = await _signer.getAddress();

    const abi = await loadAbi();
    writeContract = new ethers.Contract(MONOMINE_ADDRESS, abi, _signer);

    setTextEventually("status", `Connected: ${short(_account)}`);
    enableEventually("mineBtn", true);
    enableEventually("submitBtn", true);
    showLinkEventually("viewAddr", `${EXPLORER_ADDR_PREFIX}${_account}`);

    await refreshWalletUI();
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
        chainId: "0x279F",
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

async function rollIfNeeded() {
  try {
    if (!writeContract) return;
    setTextEventually("rollMsg", "Rolling if needed…");
    const tx = await writeContract.rollIfNeeded();
    await tx.wait();
    setTextEventually("rollMsg", " Done");
    await refreshState();
  } catch (e) {
    setTextEventually("rollMsg", e.shortMessage || e.message);
  }
}

async function refreshWalletUI() {
  const connectBtn = $$("#connectBtn");
  const addNetBtn  = $$("#addNetworkBtn");
  const mintBtn    = $$("#mintBtn");

  // connection
  let connected = !!_account;
  if (!connected && window.ethereum) {
    try {
      const eth = new ethers.BrowserProvider(window.ethereum, "any");
      const accs = await eth.send("eth_accounts", []);
      if (accs && accs.length) {
        _provider = eth;
        _signer   = await _provider.getSigner();
        _account  = await _signer.getAddress();
        connected = true;
      }
    } catch {}
  }

  // network
  let onMonad = false;
  try {
    if (_provider) {
      const net = await _provider.getNetwork();
      onMonad = Number(net.chainId) === 10143;
    }
  } catch {}

  // passport
  const passOk = connected ? await hasPassport(_account) : false;
  setPassportStatus(passOk);

  // buttons
  if (connectBtn) connectBtn.disabled = connected;
  if (addNetBtn)  addNetBtn.disabled  = !connected || onMonad;
  if (mintBtn) {
    mintBtn.disabled   = passOk;
    mintBtn.textContent = passOk ? "Passport Minted" : "Mint Passport";
  }

  // explorer
  showLinkEventually("viewAddr", connected ? (EXPLORER_ADDR_PREFIX + _account) : "", 1);
}

// share + modal
function shareCast() {
  const bestHash = (window.best && window.best.hash) || "—";
  const text = encodeURIComponent(`Mining MonoMine on Monad testnet. Best hash: ${bestHash} • Try it:`);
  window.open(`https://warpcast.com/~/compose?text=${text}`, "_blank");
}
function openTmfModal() {
  const m = $$("#tmfModal"); if (!m) return;
  m.hidden = false;
  m.querySelector(".modal__card")?.focus();
  const onEsc = (e) => { if (e.key === "Escape") closeTmfModal(); };
  m.dataset.esc = "1";
  document.addEventListener("keydown", onEsc, { once: true });
  m._escHandler = onEsc;
}
function closeTmfModal() {
  const m = $$("#tmfModal"); if (!m) return;
  m.hidden = true;
  if (m._escHandler) { document.removeEventListener("keydown", m._escHandler); delete m._escHandler; }
}

// expose if needed elsewhere
export { connect, connectSilent, addMonadNetwork, rollIfNeeded };
