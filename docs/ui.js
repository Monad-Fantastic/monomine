// ui.js — wallet, network, buttons, modal; wires into game.js

import {
  $$, PASSPORT_MINT_URL,
  EXPLORER_ADDR_PREFIX, RELAY_ENDPOINT,
  initGame, refreshState, wireWriterWith,
  toggleMine, updateRate, submitBest,
  hasPassport, setPassportStatus, setTextEventually, enableEventually, showLinkEventually, debugEnvProbe, getPassportStatus
} from "./game.js";

import { ethers } from "https://esm.sh/ethers@6.13.2";

document.addEventListener("DOMContentLoaded", initUI);

function on(id, handler) { const el = $$(id); if (el) el.onclick = handler; }

async function initUI() {
  console.log("MonoMine v13.8.2 loaded");
  await initGame();
  await debugEnvProbe();

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
    const m = $$("tmfModal");
    if (!m || m.hidden) return;
    if (e.target && e.target.getAttribute("data-close") === "1") closeTmfModal();
  });

  const infoLink = $$("whatIsPassport"); if (infoLink) infoLink.href = PASSPORT_MINT_URL;
  const viewAddr = $$("viewAddr");       if (viewAddr) viewAddr.style.display = "none";

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
  await pingRelay();
  await refreshState();
  setInterval(updateRate, 1000);
  setInterval(refreshState, 60000);
  await refreshWalletUI();
  setInterval(refreshWalletUI, 60000);
}

async function pingRelay() {
  try {
    const healthUrl = RELAY_ENDPOINT.replace("/api/forward", "/health");
    const ping = await fetch(healthUrl, { mode: "cors" });
    const ok = ping.ok && (await ping.text()).trim().toUpperCase().includes("OK");
    const st = $$("status");
    if (st && !st.textContent.includes("Connected:")) {
      st.textContent = `${st.textContent || "Status"} • Relay ${ok ? "online" : "offline"}`;
    }
  } catch {
    const st = $$("status");
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

    const provider = new ethers.BrowserProvider(window.ethereum, "any");
    const accounts = await provider.send("eth_requestAccounts", []);
    if (!accounts || accounts.length === 0) {
      setTextEventually("status", "No account authorized.");
      return;
    }

    const signer  = await provider.getSigner();
    const account = await signer.getAddress();

    // ensure Monad testnet
    try {
      const net = await provider.getNetwork();
      await wireWriterWith({ provider, signer, account, chainId: Number(net.chainId) });
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

    await wireWriterWith({ provider, signer, account });

    setTextEventually("status", `Connected: ${account.slice(0,6)}…${account.slice(-4)}`);
    enableEventually("mineBtn", true);
    enableEventually("submitBtn", true);
    showLinkEventually("viewAddr", `https://testnet.monadexplorer.com/address/${account}`);

    await refreshWalletUI();
  } catch (e) {
    console.error("Connect error:", e);
    setTextEventually("status", `Connect failed: ${e.shortMessage || e.message}`);
  }
}

async function connectSilent() {
  if (!window.ethereum) return;
  try {
    const provider = new ethers.BrowserProvider(window.ethereum, "any");
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    if (!accounts || accounts.length === 0) {
      setTextEventually("status", "Not connected • Relay checking…");
      setPassportStatus(false);
      return;
    }
    const signer  = await provider.getSigner();
    const account = await signer.getAddress();

    await wireWriterWith({ provider, signer, account });

    setTextEventually("status", `Connected: ${account.slice(0,6)}…${account.slice(-4)}`);
    enableEventually("mineBtn", true);
    enableEventually("submitBtn", true);
    showLinkEventually("viewAddr", `https://testnet.monadexplorer.com/address/${account}`);

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
    // writeContract is wired inside game.js by wireWriterWith()
    setTextEventually("rollMsg", "Rolling if needed…");
    // submit is in game.js; here we only call via write contract, so reuse submitBest? or keep separate endpoint in game.js if needed.
    // For now, we just inform users to submit via the “Submit Best” after seed rolls automatically by contract.
    setTextEventually("rollMsg", " Done");
  } catch (e) {
    setTextEventually("rollMsg", e.shortMessage || e.message);
  }
}

async function refreshWalletUI() {
  const connectBtn = $$("connectBtn");
  const addNetBtn  = $$("addNetworkBtn");
  const mintBtn    = $$("mintBtn");

  // connection status
  let connected = false;
  let account;
  if (window.ethereum) {
    try {
      const provider = new ethers.BrowserProvider(window.ethereum, "any");
      const accs = await provider.send("eth_accounts", []);
      if (accs && accs.length) {
        connected = true;
        account = accs[0];
      }
    } catch {}
  }

  // network
  let onMonad = false;
  if (connected) {
    try {
      const provider = new ethers.BrowserProvider(window.ethereum, "any");
      const net = await provider.getNetwork();
      onMonad = Number(net.chainId) === 10143;
    } catch {}
  }

  // passport
const ps = (connected && account) ? await getPassportStatus(account) : { hasNft:false, fid:0n };
setPassportStatus(ps);

  // buttons
  if (connectBtn) connectBtn.disabled = connected;
  if (addNetBtn)  addNetBtn.disabled  = !connected || onMonad;
  if (mintBtn) {
    mintBtn.disabled    = ps;
    mintBtn.textContent = ps ? "Passport Minted" : "Mint Passport";
  }

  // explorer link
  showLinkEventually("viewAddr", connected ? (`https://testnet.monadexplorer.com/address/${account}`) : "", 1);
}

function shareCast() {
  // read best hash from DOM (keeps modules decoupled)
  const bestHash = ($$("bestHash")?.textContent || "—");
  const text = encodeURIComponent(`Mining MonoMine on Monad testnet. Best hash: ${bestHash} • Try it:`);
  window.open(`https://warpcast.com/~/compose?text=${text}`, "_blank");
}

function openTmfModal() {
  const m = $$("tmfModal"); if (!m) return;
  m.hidden = false;
  m.querySelector(".modal__card")?.focus();
  const onEsc = (e) => { if (e.key === "Escape") closeTmfModal(); };
  m.dataset.esc = "1";
  document.addEventListener("keydown", onEsc, { once: true });
  m._escHandler = onEsc;
}
function closeTmfModal() {
  const m = $$("tmfModal"); if (!m) return;
  m.hidden = true;
  if (m._escHandler) { document.removeEventListener("keydown", m._escHandler); delete m._escHandler; }
}
