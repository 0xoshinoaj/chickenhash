# Chicken Hash CPU miner

在 [Robinhood Chain](https://robinhoodchain.blockscout.com) 上為 [Chicken Hash](https://chickenhash.com/#incubator) 做瀏覽器同款的 keccak PoW：搜 `keccak256(challenge, wallet, nonce)`，digest 低於 `currentTarget` 就可以 `mint`。

合約：[`0xcC13C70834516C47266C1d37dd5bb173EED8deCf`](https://robinhoodchain.blockscout.com/address/0xcC13C70834516C47266C1d37dd5bb173EED8deCf)（chain id `4663`）。

這是 CPU miner。官網 Incubator 的 GPU（WebGPU）通常比 VPS CPU 快很多。每錢包鏈上有 mint 上限（目前是 2 隻）。

## 安裝

需要 Node.js 18+。

```bash
git clone https://github.com/0xoshinoaj/chickenhash.git
cd chickenhash
npm install
cp miner/.env.example miner/.env
```

編輯 `miner/.env`，**不要把這個檔 commit 或推上 GitHub**。

## 設定

| 變數 | 說明 |
| --- | --- |
| `ADDRESS` | 只挖不鑄時填錢包地址。hash 綁這個地址，別人不能偷用你的 nonce。 |
| `PRIVATE_KEY` | 找到後要自動送交易才需要。 |
| `AUTO_MINT` | 設 `1` 才會自動 `mint`。沒開的話只會印 `FOUND digest` / `nonce`。 |
| `THREADS` | CPU 執行緒，預設核心數 − 1。 |
| `RPC` | 預設公開節點。建議換成自己的 Alchemy 等 RPC。 |
| `POLL_MS` | 輪詢 `miningState()` 的間隔，預設 2500。challenge 變了會換新 job。 |

錢包裡要有 Robinhood Chain 的 ETH（gas；過了免費 epoch 還要付當前 mint 價）。

## 執行

```bash
node miner/mine.js
```

或：

```bash
npm run mine
```

log 裡：

- `job N minted X/7000`：鏈上狀態變了，重開一輪搜尋。`minted` 增加通常代表有人剛孵成功，challenge 已換。
- `hashrate`：本機算力。
- `FOUND`：找到合格 nonce。若 `AUTO_MINT=1` 會接著送交易。

## 多台機器

每台用**同一個** `ADDRESS`（自動 mint 則同一把 `PRIVATE_KEY`）。nonce prefix 是隨機的，不用手動切範圍。建議只讓一台開 `AUTO_MINT=1`，避免同時送兩筆 mint。

## 免責

非官方工具。PoW 難度隨全網算力變，CPU 不一定挖得到。NFT / `$EGG` 沒有保證收益。
