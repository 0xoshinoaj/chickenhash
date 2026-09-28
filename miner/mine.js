"use strict";

const os = require("os");
const fs = require("fs");
const { Worker } = require("worker_threads");
const path = require("path");
const { ethers } = require("ethers");

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const i = s.indexOf("=");
      if (i < 1) continue;
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] == null) process.env[k] = v;
    }
  } catch {}
}
loadEnv(path.join(__dirname, ".env"));
loadEnv(path.join(__dirname, "..", ".env"));

const CONTRACT = "0xcC13C70834516C47266C1d37dd5bb173EED8deCf";
const CHAIN_ID = 4663;
const RPC = process.env.RPC || "https://rpc.mainnet.chain.robinhood.com";
const TWO256 = 1n << 256n;

const ABI = [
  "function miningState() view returns (tuple(bytes32 challenge, uint256 currentTarget, uint256 storedTarget, uint256 price, uint256 epoch, uint256 totalMinted, uint256 maxSupply, bool mintOpen, uint256 lastMintTime, uint256 targetInterval, uint256[10] prices, uint256 maxPerWallet, uint256 freePerWallet, uint256 timestamp))",
  "function mint(uint256 nonce, bytes32 expectedChallenge) payable returns (uint256 tokenId)",
  "function minedCount(address) view returns (uint256)",
  "function freeLeft(address) view returns (uint256)",
  "event Hatched(address indexed miner, uint256 indexed tokenId, bytes32 digest, uint256 nonce, uint256 epoch, uint256 price, bytes32 newChallenge, uint256 newTarget)",
];

function envInt(name, fallback) {
  const v = process.env[name];
  return v == null || v === "" ? fallback : Number(v);
}

function fmtH(n) {
  const u = ["H/s", "KH/s", "MH/s", "GH/s"];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) {
    n /= 1000;
    i++;
  }
  return (i === 0 ? Math.round(n) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + " " + u[i];
}

function targetWords(t) {
  const w = [];
  for (let i = 0; i < 8; i++) w.push(Number((t >> BigInt(224 - 32 * i)) & 0xffffffffn));
  return w;
}

function nonceFrom(prefixHex, counter) {
  const buf = Buffer.alloc(32);
  Buffer.from(prefixHex, "hex").copy(buf, 0);
  buf.writeUInt32BE(counter >>> 0, 28);
  return BigInt("0x" + buf.toString("hex"));
}

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

async function main() {
  const threads = Math.max(1, envInt("THREADS", Math.max(1, os.cpus().length - 1)));
  const autoMint = process.env.AUTO_MINT === "1";
  const pk = process.env.PRIVATE_KEY;
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const contract = new ethers.Contract(CONTRACT, ABI, provider);

  let wallet = null;
  let address = (process.env.ADDRESS || "").trim();
  if (pk) {
    wallet = new ethers.Wallet(pk, provider);
    address = wallet.address;
  }
  if (!address) {
    console.error("Set ADDRESS (0x...) to mine, or PRIVATE_KEY to mine + mint.");
    process.exit(1);
  }
  address = ethers.getAddress(address);

  log("wallet", address);
  log("rpc", RPC);
  log("threads", threads, "autoMint", autoMint && !!wallet);

  let jobId = 0;
  let workers = [];
  let hashes = 0;
  let lastRateAt = Date.now();
  let submitting = false;
  let lastChallenge = null;
  let lastTarget = null;
  let minted = 0;

  function killWorkers() {
    for (const w of workers) {
      try {
        w.postMessage("stop");
        w.terminate();
      } catch {}
    }
    workers = [];
  }

  function spawn(state) {
    killWorkers();
    jobId++;
    const payload = {
      challenge: state.challenge,
      address,
      target: Array.from(targetWords(state.currentTarget)),
    };
    for (let i = 0; i < threads; i++) {
      const w = new Worker(path.join(__dirname, "worker.js"), { workerData: payload });
      w.on("message", (m) => {
        if (m.type === "progress") hashes += m.hashes;
        else if (m.type === "found") onFound(state, m).catch((e) => log("found error", e.message || e));
      });
      w.on("error", (e) => log("worker error", e.message || e));
      workers.push(w);
    }
    const diff = Number(TWO256 / (state.currentTarget + 1n));
    log(
      `job ${jobId} minted ${state.totalMinted}/${state.maxSupply} epoch ${Number(state.epoch) + 1} price ${ethers.formatEther(state.price)} ETH difficulty ${fmtH(diff).replace("/s", "")}`
    );
  }

  async function onFound(state, m) {
    hashes += m.hashes || 0;
    const nonce = nonceFrom(m.prefix, m.counter);
    log("FOUND digest", m.digest, "nonce", "0x" + nonce.toString(16));
    if (!autoMint || !wallet || submitting) return;
    submitting = true;
    killWorkers();
    try {
      const live = await contract.miningState();
      if (live.challenge !== state.challenge) {
        log("stale challenge, someone else hatched first");
        return;
      }
      const signerC = contract.connect(wallet);
      if (live.maxPerWallet > 0n) {
        const n = await signerC.minedCount(address);
        if (n >= live.maxPerWallet) {
          log("wallet already at maxPerWallet", n.toString());
          process.exit(0);
        }
      }
      if (live.price === 0n) {
        const left = await signerC.freeLeft(address);
        if (left === 0n) {
          log("no free mints left");
          return;
        }
      }
      const est = await signerC.mint.estimateGas(nonce, live.challenge, { value: live.price });
      const tx = await signerC.mint(nonce, live.challenge, {
        value: live.price,
        gasLimit: (est * 15n) / 10n,
      });
      log("tx", tx.hash);
      const rc = await tx.wait();
      const ev = rc.logs
        .map((l) => {
          try {
            return contract.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((x) => x && x.name === "Hatched");
      minted += 1;
      log("hatched tokenId", ev ? ev.args.tokenId.toString() : "?", "mints this run", minted);
    } catch (e) {
      log("mint failed", e.shortMessage || e.message || e);
    } finally {
      submitting = false;
      lastChallenge = null;
    }
  }

  setInterval(() => {
    const now = Date.now();
    const dt = (now - lastRateAt) / 1000;
    if (dt >= 1) {
      log("hashrate", fmtH(hashes / dt), "workers", workers.length);
      hashes = 0;
      lastRateAt = now;
    }
  }, 5000);

  for (;;) {
    let st;
    try {
      st = await contract.miningState();
    } catch (e) {
      log("rpc error", e.message || e);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    if (!st.mintOpen) {
      if (workers.length) {
        log("mint closed, waiting");
        killWorkers();
      }
    } else if (st.totalMinted >= st.maxSupply) {
      log("sold out");
      killWorkers();
      process.exit(0);
    } else if (st.maxPerWallet > 0n) {
      try {
        const n = await contract.minedCount(address);
        if (n >= st.maxPerWallet) {
          log("this wallet already minted", n.toString(), "/", st.maxPerWallet.toString());
          killWorkers();
          process.exit(0);
        }
      } catch {}
    }

    if (
      st.mintOpen &&
      !submitting &&
      (st.challenge !== lastChallenge || st.currentTarget !== lastTarget)
    ) {
      lastChallenge = st.challenge;
      lastTarget = st.currentTarget;
      spawn(st);
    }

    await new Promise((r) => setTimeout(r, envInt("POLL_MS", 2500)));
  }
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
