/**
 * Polymarket CLOB v2 交易客户端封装（@polymarket/clob-client-v2 + viem）。
 * 见官方 Quickstart：https://docs.polymarket.com/quickstart/first-order
 */

import { Chain, ClobClient, OrderType, Side, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

function normalizePrivateKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return s.startsWith('0x') ? s : `0x${s}`;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.host]
 * @param {string} [opts.privateKey] 默认读 POLYMARKET_PRIVATE_KEY 或 PRIVATE_KEY
 * @param {string} [opts.rpcUrl] 默认 POLYGON_RPC_URL 或 https://polygon-rpc.com
 * @param {number} [opts.signatureType] 默认 POLYMARKET_SIGNATURE_TYPE 或 EOA(0)
 * @param {string} [opts.funderAddress] 默认 POLYMARKET_FUNDER_ADDRESS 或 signer 地址
 */
export async function createPolymarketClobTradingClient(opts = {}) {
  const pk = normalizePrivateKey(opts.privateKey ?? process.env.POLYMARKET_PRIVATE_KEY ?? process.env.PRIVATE_KEY);
  if (!pk) {
    throw new Error('Set POLYMARKET_PRIVATE_KEY (0x…) or PRIVATE_KEY for CLOB trading');
  }
  const host = opts.host || process.env.POLYMARKET_CLOB_HOST || 'https://clob.polymarket.com';
  const rpcUrl = opts.rpcUrl || process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
  const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(rpcUrl),
  });

  const tempClient = new ClobClient({
    host,
    chain: Chain.POLYGON,
    signer,
  });
  const creds = await tempClient.createOrDeriveApiKey();

  const sigFromEnv = Number(process.env.POLYMARKET_SIGNATURE_TYPE);
  const sigFromOpts = opts.signatureType != null ? Number(opts.signatureType) : NaN;
  const sigNum = Number.isFinite(sigFromOpts)
    ? sigFromOpts
    : Number.isFinite(sigFromEnv)
      ? sigFromEnv
      : SignatureTypeV2.EOA;
  const signatureType = /** @type {import('@polymarket/clob-client-v2').SignatureTypeV2} */ (sigNum);
  const funderAddress = opts.funderAddress || process.env.POLYMARKET_FUNDER_ADDRESS || account.address;

  const client = new ClobClient({
    host,
    chain: Chain.POLYGON,
    signer,
    creds,
    signatureType,
    funderAddress,
  });

  return { client, address: account.address, creds };
}

/**
 * @param {import('@polymarket/clob-client-v2').ClobClient} client
 * @param {{ tokenID: string, price: number, size: number, side: import('@polymarket/clob-client-v2').Side }} userOrder
 */
export async function createAndPostGtcLimitOrder(client, userOrder) {
  const tickSize = await client.getTickSize(userOrder.tokenID);
  const negRisk = await client.getNegRisk(userOrder.tokenID);
  const side = userOrder.side === 'SELL' || userOrder.side === Side.SELL ? Side.SELL : Side.BUY;
  const order = {
    tokenID: userOrder.tokenID,
    price: userOrder.price,
    size: userOrder.size,
    side,
  };
  return client.createAndPostOrder(order, { tickSize, negRisk: Boolean(negRisk) }, OrderType.GTC);
}

export { Side, OrderType, Chain, SignatureTypeV2 };
