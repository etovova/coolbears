import { settings as S } from './settings.mjs';
import { validateRpcEndpoint } from './rpc.mjs';

const CONFIG_ERROR = 'Подключение Devnet на сайте настроено неверно. Проверка и подпись остановлены; сохранённый результат доступен в отчёте.';

// This address is committed and public. It must identify a credential-free
// relay, never a provider API URL. Request-time network/genesis checks remain
// mandatory: validating a hostname cannot prove where its DNS will resolve.
export function validateSiteRpcEndpoint(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) throw Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/rpc') throw Error();
    // Canonical input also rejects hidden normalizations, empty ?/# markers,
    // explicit :443, encoded path components and path traversal to /rpc.
    if (value !== `https://${url.hostname}/rpc`) throw Error();
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)) throw Error();
    if (/(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|arpa|onion|test|invalid|example)$/.test(url.hostname)) throw Error();
    return url.href;
  } catch {
    // A malformed repository setting may contain a secret; never echo it.
    throw new Error(CONFIG_ERROR);
  }
}

export function deploymentRpc(configured = S.siteRpc) {
  return configured === ''
    ? Object.freeze({ endpoint: validateRpcEndpoint(S.rpc), kind: 'public-devnet' })
    : Object.freeze({ endpoint: validateSiteRpcEndpoint(configured), kind: 'site-devnet' });
}
