import config from './deployment.mjs';
import {mountPublicMint} from './main.mjs';
export const mount=options=>mountPublicMint({...options,config});
