import { updateV1 } from '@metaplex-foundation/mpl-core';
import { publicKey } from '@metaplex-foundation/umi';
import { assertDevnet, SITE } from './builders.mjs';

// Only the two already verified rehearsal assets. No arbitrary URI or address input.
export const TEST_COLLECTION = '7TBBVkBziGZxGp8a8Uhv6U27fpj8gLQJP2mFE4H19dj9';
export const TEST_OWNER = 'FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y';
export const TEST_ASSETS = ['8EQdWaor3Pj9y2J3V7a7zR1bfp2m1m5zHcsdjRtc3NQK', 'bqxPFpkcKhejMBD5YnS5LGVLefEtEhseLgn63xBhQ8n'];
export function testRevealState(asset, collection) {
  const index = TEST_ASSETS.indexOf(asset.publicKey);
  if (index < 0 || collection.publicKey !== TEST_COLLECTION || collection.updateAuthority !== TEST_OWNER || asset.owner !== TEST_OWNER || asset.updateAuthority.type !== 'Collection' || asset.updateAuthority.address !== TEST_COLLECTION || collection.royalties?.basisPoints !== 700 || asset.royalties?.basisPoints !== 700) throw Error('Это не подтверждённый набор для тестового раскрытия.');
  const id = String(index).padStart(4, '0');
  const name = `CoolBears #${id}`;
  const uri = `${SITE}/metadata/devnet-reveal/${id}.json`;
  const revealed = asset.name === name && asset.uri === uri;
  if (!revealed && !(asset.name === `${name} — Hidden Bear` && asset.uri === `${SITE}/metadata/hidden/${id}.json`)) throw Error('Неожиданные метаданные тестового NFT.');
  return { name, uri, revealed, index };
}
export function testRevealBuilder(umi, asset, collection) {
  assertDevnet(umi);
  if (umi.identity.publicKey !== TEST_OWNER) throw Error('Подключи владельца тестовой коллекции.');
  const target = testRevealState(asset, collection);
  if (target.revealed) throw Error('Этот тестовый NFT уже раскрыт.');
  return updateV1(umi, { asset: publicKey(asset.publicKey), collection: publicKey(TEST_COLLECTION), authority: umi.identity, name: target.name, uri: target.uri });
}
