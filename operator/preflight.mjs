import { publicKey } from '@metaplex-foundation/umi';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { policy } from './prepare.mjs';

export const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const PROGRAMS = [
  'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
  'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J',
  'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ',
];

export function validateEndpoint(endpoint, allowLocal = false) {
  if (!endpoint) throw Error('COOLBEARS_RPC_URL is required. There is no automatic public RPC fallback.');
  const url = new URL(endpoint);
  const local = allowLocal && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw Error('RPC must use HTTPS');
  if (url.hash || url.username || url.password) throw Error('Unsupported RPC URL');
  return url;
}

export async function checkRpc({ endpoint, owner = policy.owner, fetchImpl = fetch, allowLocal = false, timeoutMs = 15000 } = {}) {
  validateEndpoint(endpoint, allowLocal);
  publicKey(owner);
  const methods = [];
  async function read(method, params = []) {
    const start = Date.now();
    const id = methods.length + 1;
    const record = { method };
    methods.push(record);
    // One request per stage. No hidden retries, endpoint rotation or submissions.
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    record.httpStatus = response.status;
    if (!response.ok) throw Error(`RPC_HTTP_${response.status}: ${method}`);
    const body = await response.json();
    record.durationMs = Date.now() - start;
    if (body.jsonrpc !== '2.0' || body.id !== id) throw Error(`RPC_INVALID_RESPONSE: ${method}`);
    if (body.error) throw Error(`RPC_ERROR_${body.error.code}: ${method}`);
    if (!Object.hasOwn(body, 'result')) throw Error(`RPC_MISSING_RESULT: ${method}`);
    return body.result;
  }
  try {
    const genesis = await read('getGenesisHash');
    if (genesis !== DEVNET) throw Error('WRONG_NETWORK: Devnet required');
    const programs = await read('getMultipleAccounts', [PROGRAMS, { encoding: 'base64', commitment: 'finalized' }]);
    if (!programs?.context || !Array.isArray(programs.value) || programs.value.length !== PROGRAMS.length || programs.value.some(account => !account?.executable)) throw Error('PROGRAM_NOT_EXECUTABLE');
    const balance = await read('getBalance', [owner, { commitment: 'finalized', minContextSlot: programs.context.slot }]);
    if (!Number.isSafeInteger(balance?.value) || balance.value < 0) throw Error('INVALID_BALANCE');
    const blockhash = await read('getLatestBlockhash', [{ commitment: 'confirmed', minContextSlot: programs.context.slot }]);
    if (!blockhash?.value?.blockhash || !Number.isSafeInteger(blockhash.value.lastValidBlockHeight)) throw Error('INVALID_BLOCKHASH');
    publicKey(blockhash.value.blockhash);
    return { checkedAt: new Date().toISOString(), status: 'read-path-passed', cluster: 'devnet', owner, balanceLamports: balance.value, programCount: PROGRAMS.length, methods, writes: 0, simulationVerified: false, walletVerified: false };
  } catch (error) {
    return { checkedAt: new Date().toISOString(), status: 'blocked', code: error.name === 'TimeoutError' ? 'RPC_TIMEOUT' : String(error.message).replaceAll(endpoint, '[RPC]').slice(0, 180), methods, writes: 0, simulationVerified: false, walletVerified: false };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkRpc({ endpoint: process.env.COOLBEARS_RPC_URL });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'read-path-passed') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
