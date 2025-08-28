// ====== CONFIG======
const MONAD_RPC = "https://testnet-rpc.monad.xyz"; 
const MONOMINE_ADDRESS = "0x49c52AEb95BEA2E22bede837B77C4e482840751e"; // THE GAME 
const FORWARDER_ADDRESS = "0xb25D7eAba78995880E7d64C4003ab23640246968"; // THE Monad Fantastic forwarder 
const RELAY_ENDPOINT = "https://stakepoolelite.duckdns.org/api/forward";

const PASSPORT_MINT_URL = "https://warpcast.com/~/compose?text=Mint%20your%20TMF%20Passport%20to%20play%20MonoMine&embeds[]=https%3A%2F%2Fstakepoolelite.duckdns.org%2Fframe";

const EXPLORER_ADDR_PREFIX = "https://testnet.monadexplorer.com/address/"; 
const EXPLORER_TX_PREFIX = "https://testnet.monadexplorer.com/tx/";

// ====== Load ABI from Foundry JSON ======
async function loadAbi() {
  const j = await fetch("./contracts/MonoMine.json").then(r => r.json());
  return j.abi || j; 
}



// ====== DOM helpers ======
const $$ = (id) => document.getElementById(id);
const on = (id, handler) => { const el = $$(id); if (el) el.onclick = handler; };

document.addEventListener("DOMContentLoaded", init);

// ====== State ======
let readProvider, provider, signer, contract, writeContract, account;
let seedHex = null;
let mining = false;
let best = { hash: null, nonce: null, value: 2n ** 256n - 1n };
let hashes = 0;
let lastTick = Date.now();



async function init() {
  const abi = await loadAbi();
  readProvider = new ethers.JsonRpcProvider(MONAD_RPC);
  contract = new ethers.Contract(MONOMINE_ADDRESS, abi, readProvider);

  // Null-safe bindings
  on("connectBtn", connect);
  on("mineBtn", toggleMine);
  on("submitBtn", submitBest);
  on("shareBtn", shareCast);
  on("rollBtn", rollIfNeeded);
  on("mintBtn", () => window.open(PASSPORT_MINT_URL, "_blank"));
  on("mintBtn2", () => window.open(PASSPORT_MINT_URL, "_blank"));
  const infoLink = $$("#whatIsPassport");
  if (infoLink) infoLink.href = PASSPORT_MINT_URL;

  const viewAddr = $$("#viewAddr");
  if (viewAddr) viewAddr.style.display = "none";

  await refreshState();
  setInterval(updateRate, 1000);
}

async function connect() {
  try {
    const statusEl   = $$("#status");
    const mineBtn    = $$("#mineBtn");
    const submitBtn  = $$("#submitBtn");
    const viewAddrEl = $$("#viewAddr");

    provider = new ethers.BrowserProvider(window.ethereum, "any");
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    account = await signer.getAddress();
    const abi = await loadAbi();
    writeContract = new ethers.Contract(MONOMINE_ADDRESS, abi, signer);

    if (statusEl) statusEl.textContent = `Connected: ${short(account)}`;
    if (mineBtn) mineBtn.disabled = false;
    if (submitBtn) submitBtn.disabled = false;

    if (viewAddrEl) {
      viewAddrEl.href = EXPLORER_ADDR_PREFIX + account;
      viewAddrEl.style.display = "inline-block";
    }
  } catch (e) {
    const statusEl = $$("#status");
    if (statusEl) statusEl.textContent = `Connect failed: ${e.shortMessage || e.message}`;
    console.error(e);
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

    const dayEl = $$("#day");
    if (dayEl) dayEl.textContent = day.toString();

    const seedEl = $$("#seed");
    if (seedEl) seedEl.textContent = seedHex;

    const leaderEl = $$("#leader");
    if (leaderEl) {
      const leaderStr =
        bestS.player === ethers.ZeroAddress
          ? "—"
          : `<a class="link" target="_blank" href="${EXPLORER_ADDR_PREFIX}${bestS.player}">${short(bestS.player)}</a> (FID ${bestS.fid}) @ ${bestS.bestHash}`;
      leaderEl.innerHTML = leaderStr;
    }
  } catch (e) {
    console.error(e);
  }
}

async function rollIfNeeded() {
  try {
    if (!signer) await connect();
    $$("#rollMsg").textContent = "Rolling if needed…";
    const tx = await writeContract.rollIfNeeded();
    await tx.wait();
    $$("#rollMsg").textContent = " Done";
    await refreshState();
  } catch (e) {
    $$("#rollMsg").textContent = `${e.shortMessage || e.message}`;
  }
}

function randNonce() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "0x" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function toggleMine() {
  if (!seedHex) {
    await refreshState();
    if (!seedHex) return;
  }
  mining = !mining;
  $$("#mineBtn").textContent = mining ? "Stop Mining" : "Start Mining";
  if (mining) mineLoop();
}

async function mineLoop() {
  while (mining) {
    // We don't know FID here; using 0 keeps comparison monotonic.
    const nonce = randNonce();
    const h = ethers.keccak256(ethers.concat([seedHex, ethers.zeroPadValue(0, 32), nonce]));
    const hv = BigInt(h);
    hashes++;
    if (hv < best.value) {
      best = { hash: h, nonce, value: hv };
      $$("#bestHash").textContent = best.hash;
      $$("#bestNonce").textContent = best.nonce;
    }
    // Yield to UI
    await new Promise(r => setTimeout(r, 0));
  }
}

function updateRate() {
  const rateEl = $$("#rate");
  if (!rateEl) return;
  if (typeof lastTick !== "number") lastTick = Date.now();  // safety init
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  if (dt >= 0.95) {
    const rate = Math.round(hashes / dt);
    rateEl.textContent = `hashes/s: ${rate}`;
    hashes = 0;
    lastTick = now;
  }
}

const useRelayEl = $$("#useRelay");
const useRelay = () => useRelayEl ? useRelayEl.checked : true; // default on

async function submitBest() {
  if (!signer) await connect();
  if (!best.nonce) {
    $$("#txMsg").textContent = "Mine first to get a nonce.";
    return;
  }
  $$("#txMsg").textContent = useRelay() ? "Relaying (gasless)..." : "Submitting tx…";

  try {
    if (useRelay()) {
      // Gasless path via TMF relayer
      const data = writeContract.interface.encodeFunctionData("submit", [best.nonce]);
      const res = await submitViaRelay(data);
      $$("#txMsg").textContent = `Relay accepted: ${JSON.stringify(res).slice(0, 120)}…`;
    } else {
      // Direct on-chain tx
      const tx = await writeContract.submit(best.nonce);
      $$("#txMsg").textContent = `Submitting… ${tx.hash}`;
      await tx.wait();
      $$("#txMsg").innerHTML = `Submitted: <a href="${EXPLORER_TX_PREFIX}${tx.hash}" target="_blank" class="link">${short(tx.hash)}</a>`;
    }
    await refreshState();
  } catch (e) {
    console.error(e);
    $$("#txMsg").textContent = ` ${e.shortMessage || e.message}`;
  }
}

// EIP-2771 style ForwardRequest 
async function submitViaRelay(calldata) {
  const network = await signer.provider.getNetwork();
  const chainId = Number(network.chainId);

  const req = {
    from: account,
    to: MONOMINE_ADDRESS,
    value: 0,
    gas: 200_000,
    nonce: 0,        
    data: calldata
  };

  const domain = {
    name: "TMF EntryForwarder",
    version: "1",
    chainId,
    verifyingContract: FORWARDER_ADDRESS
  };

  const types = {
    ForwardRequest: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "gas", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "data", type: "bytes" }
    ]
  };

  const signature = await signer.signTypedData(domain, types, req);

  const res = await fetch(RELAY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request: req, signature })
  });
  if (!res.ok) throw new Error(`Relay HTTP ${res.status}`);
  return await res.json();
}

function shareCast() {
  const text = encodeURIComponent(
    `Mining MonoMine on Monad testnet. Best hash: ${best.hash || "—"} • Try it:`
  );
  const url = `https://warpcast.com/~/compose?text=${text}`;
  window.open(url, "_blank");
}
