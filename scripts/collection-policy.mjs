// Owner-approved copy and branding. Changing IPFS metadata affects immutable URIs.
import assert from 'node:assert/strict';

export const COLLECTION_DESCRIPTION = '10,000 unique CoolBears on TON. Everyone gets a bear. Not everyone gets a legend.\n\nNo real value. No financial returns. No celebrity backing. Don’t buy expecting profit. CoolBears is just for fun.\n\nMint will be available at https://coolbears-nfts.com';
export const COLLECTION_LOGO = 'ipfs://bafkreic5qomnssl55k4zuhcx2fd56qyeoey7ve2ubf7kfb4tqxz363lr44';
export const COLLECTION_BANNER = 'ipfs://bafkreigt7avbecihwpwfor3cqetvqc42d6ahk5twnerwd5b2km5vesf3su';

export function validateCollectionMetadata(metadata) {
  assert.equal(metadata.name, 'CoolBears', 'Unapproved collection name');
  assert.equal(metadata.description, COLLECTION_DESCRIPTION,
    'Collection description must contain exactly the three owner-approved paragraphs');
  assert.equal(metadata.image, COLLECTION_LOGO, 'Use the approved original collection logo');
  assert.equal(metadata.cover_image, COLLECTION_BANNER, 'Use the approved original collection banner');
  assert.equal(metadata.external_url, 'https://coolbears-nfts.com/');
  assert.deepEqual(metadata.social_links, ['https://coolbears-nfts.com/']);
  assert.equal(metadata.marketplace, 'getgems.io');
  assert.deepEqual(Object.keys(metadata).sort(),
    ['name', 'description', 'image', 'cover_image', 'external_url', 'social_links', 'marketplace'].sort(),
    'Unapproved collection metadata fields');
  return true;
}
