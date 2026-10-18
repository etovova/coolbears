import { createNullDownloader } from '/public-mainnet/modules/d794382216bf9aa1a1f5.mjs';
import { createNullEddsa } from '/public-mainnet/modules/4b606ca878ead457bebe.mjs';
import { createNullHttp } from '/public-mainnet/modules/66745d606473a0dc67e7.mjs';
import { createNullProgramRepository } from '/public-mainnet/modules/b5cbb0051a29891295ea.mjs';
import { createNullRpc } from '/public-mainnet/modules/a94ff52ff56f99c44c8a.mjs';
import { createNullSerializer } from '/public-mainnet/modules/e538afa5389815e9275d.mjs';
import { createNullSigner } from '/public-mainnet/modules/cc1edb6b160ac1869fc9.mjs';
import { createNullTransactionFactory } from '/public-mainnet/modules/63a724cdbb7c0ab75d75.mjs';
import { createNullUploader } from '/public-mainnet/modules/39991619f803a4d5d872.mjs';

/**
 * A Umi context object that uses all of the interfaces provided by Umi.
 * Once created, the end-user can pass this object to any function that
 * requires some or all of these interfaces.
 *
 * @category Context and Interfaces
 */

/**
 * A helper method that creates a Umi context object using only
 * Null implementations of the interfaces. This can be useful to
 * create a full Umi context object when only a few of the interfaces
 * are needed.
 *
 * @category Context and Interfaces
 */
const createNullContext = () => ({
  downloader: createNullDownloader(),
  eddsa: createNullEddsa(),
  http: createNullHttp(),
  identity: createNullSigner(),
  payer: createNullSigner(),
  programs: createNullProgramRepository(),
  rpc: createNullRpc(),
  serializer: createNullSerializer(),
  transactions: createNullTransactionFactory(),
  uploader: createNullUploader()
});

export { createNullContext };

