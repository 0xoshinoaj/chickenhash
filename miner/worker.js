"use strict";

const { parentPort, workerData } = require("worker_threads");
const crypto = require("crypto");
const { baseState, mineRange, digestFor } = require("./keccak-miner.js");

const CHUNK = 20000;
const challenge = Buffer.from(workerData.challenge.slice(2), "hex");
const address = Buffer.from(workerData.address.slice(2), "hex");
const target = Uint32Array.from(workerData.target);

function freshPrefix() {
  return new Uint8Array(crypto.randomBytes(28));
}

let prefix = freshPrefix();
let S = baseState(challenge, address, prefix);
let counter = 0;
let hashes = 0;

function tick() {
  const hit = mineRange(S, counter, CHUNK, target);
  if (hit >= 0) {
    hashes += hit - counter + 1;
    const digest = Buffer.from(digestFor(S, hit));
    parentPort.postMessage({
      type: "found",
      prefix: Buffer.from(prefix).toString("hex"),
      counter: hit >>> 0,
      digest: "0x" + digest.toString("hex"),
      hashes,
    });
    hashes = 0;
    prefix = freshPrefix();
    S = baseState(challenge, address, prefix);
    counter = 0;
  } else {
    hashes += CHUNK;
    counter += CHUNK;
    if (counter > 0xffffffff - CHUNK) {
      prefix = freshPrefix();
      S = baseState(challenge, address, prefix);
      counter = 0;
    }
  }
  if (hashes >= 200000) {
    parentPort.postMessage({ type: "progress", hashes });
    hashes = 0;
  }
  setImmediate(tick);
}

parentPort.on("message", (m) => {
  if (m === "stop") process.exit(0);
});

tick();
