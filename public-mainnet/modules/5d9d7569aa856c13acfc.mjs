import config from '/public-mainnet/modules/33290fd1bfd4d974b011.mjs';
import {mountPublicMint} from '/public-mainnet/modules/4b03b537b1daf8c91c30.mjs';
export const mount=options=>mountPublicMint({...options,config});
