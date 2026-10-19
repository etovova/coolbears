import { mapSerializer } from '/public-mainnet/modules/38fcfb4e7f1fb4c9297f.mjs';
import { baseXReslice } from '/public-mainnet/modules/7044b8adca187fb13a7e.mjs';

/**
 * A string serializer that uses base64 encoding.
 * @category Serializers
 */
const base64 = mapSerializer(baseXReslice('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', 6), value => value.replace(/=/g, ''), value => value.padEnd(Math.ceil(value.length / 4) * 4, '='));

export { base64 };

