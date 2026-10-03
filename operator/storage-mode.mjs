// Shared public storage intent. A declared commitment binds SDK instructions;
// its presence does not prove that a private final mapping has been verified.
import { getCandyMachineSize } from '@metaplex-foundation/mpl-core-candy-machine';

const check = (condition, code) => { if (!condition) throw Error(code); };
const byteLength = value => new TextEncoder().encode(value).length;

export const CONFIG_LINES = 'config-lines';
export const HIDDEN_SETTINGS = 'hidden-settings';

export function validateHiddenCommitmentSha256(value) {
  check(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && value !== '0'.repeat(64), 'INVALID_HIDDEN_COMMITMENT_SHA256');
  return value;
}

function templateName(policy) {
  check(typeof policy.revealedName === 'string', 'INVALID_REVEALED_NAME_TEMPLATE');
  check(policy.revealedName.split('{index:04d}').length === 2, 'INVALID_REVEALED_NAME_TEMPLATE');
  const name = policy.revealedName.replace('{index:04d}', '$ID+1$');
  check(byteLength(name) <= 32, 'HIDDEN_NAME_TOO_LONG');
  return name;
}

function indexedBase(policy) {
  const base = new URL(`${policy.website}/metadata/hidden-indexed/`);
  check(base.protocol === 'https:', 'INVALID_HIDDEN_METADATA_ORIGIN');
  check(!base.username && !base.password && !base.search && !base.hash, 'INVALID_HIDDEN_METADATA_ORIGIN');
  return base.href;
}

// The separate owner reserve retains its original zero-padded name and URI;
// this indexed route is only for machine mint IDs 1–9999.
// SDK variable substitution uses plain decimal rather than zero padding.
export function resolveHiddenIndexedMetadata(policy, index) {
  check(Number.isSafeInteger(index) && index >= 1 && index < policy.supply, 'INVALID_HIDDEN_METADATA_INDEX');
  templateName(policy);
  return { name: policy.revealedName.replace('{index:04d}', String(index)),
    uri: `${indexedBase(policy)}${index}.json` };
}

export function resolveStorageProfile(policy, { storageMode = CONFIG_LINES, hiddenCommitmentSha256 } = {}) {
  check(Number.isSafeInteger(policy.supply) && policy.supply >= 2, 'INVALID_STORAGE_SUPPLY');
  check([CONFIG_LINES, HIDDEN_SETTINGS].includes(storageMode), 'INVALID_STORAGE_MODE');
  if (storageMode === HIDDEN_SETTINGS) {
    const hiddenSettings = { name: templateName(policy),
      uri: `${indexedBase(policy)}$ID+1$.json`,
      hash: validateHiddenCommitmentSha256(hiddenCommitmentSha256) };
    check(byteLength(hiddenSettings.uri) <= 200, 'HIDDEN_URI_TOO_LONG');
    return { storageMode, configLineSettings: null, hiddenSettings,
      machineSpace: getCandyMachineSize(policy.supply - 1, null) };
  }
  // Do not silently discard a caller's hidden commitment in the default mode.
  check(hiddenCommitmentSha256 === undefined, 'HIDDEN_COMMITMENT_REQUIRES_HIDDEN_SETTINGS');
  const lastIndex = String(policy.supply - 1).padStart(4, '0');
  const configLineSettings = { prefixName: '',
    nameLength: byteLength(policy.hiddenName.replace('{index:04d}', lastIndex)),
    prefixUri: '', uriLength: byteLength(`${policy.website}/metadata/hidden/${lastIndex}.json`),
    isSequential: false };
  return { storageMode, configLineSettings, hiddenSettings: null,
    machineSpace: getCandyMachineSize(policy.supply - 1, configLineSettings) };
}

// JSON/public profiles use a hex digest; the official SDK expects exactly 32
// bytes. Keep that representation conversion explicit at SDK boundaries.
export function hiddenSettingsForSdk(settings) {
  if (settings === null || settings === undefined) return settings;
  const hash = validateHiddenCommitmentSha256(settings.hash);
  return { ...settings, hash: Uint8Array.from(hash.match(/../g), value => Number.parseInt(value, 16)) };
}
