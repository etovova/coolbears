import {createBuyerStorage} from '../browser-storage.mjs';
import {createBuyerWalletClient} from '../wallet-client.mjs';
import {createBuyerPreparationClient} from '../gateway/preparation-client.mjs';
import {createBuyerCheckClient} from '../gateway/client.mjs';
import {createBuyerSubmissionTransport} from '../gateway/submission-client.mjs';
import {createBuyerSender} from '../sender.mjs';
import {createBuyerResponseRecovery} from '../response-recovery-client.mjs';
import {createBuyerPrewalletRecovery} from '../prewallet-recovery-client.mjs';
import {createBuyerCustodyRecovery} from '../custody-recovery-client.mjs';
import {createPrivateBuyerController} from './controller.mjs';
import {createScopeIndex,validateConsoleConfig} from './config.mjs';
export function createPrivateBuyerConsole(config,{onChange=()=>{}}={}){
  config=validateConsoleConfig(config);
  if(globalThis.location?.origin!==config.origin)throw Error('CONSOLE_ORIGIN');
  const storage=createBuyerStorage(),transport=createBuyerSubmissionTransport({origin:config.origin}),
    checkPrepared=createBuyerCheckClient({origin:config.origin}),prepare=createBuyerPreparationClient({origin:config.origin});
  // Neither build configuration, query strings nor UI options can enable sending.
  return createPrivateBuyerController({config,storage,index:createScopeIndex({config}),prepare,onChange,sendingEnabled:false,
    makePorts:scope=>({wallet:createBuyerWalletClient({storage,scope,checkPrepared,onChange}),
      sender:createBuyerSender({storage,scope,transport}),response:createBuyerResponseRecovery({storage,scope,transport}),
      prewallet:createBuyerPrewalletRecovery({storage,scope,transport}),custody:createBuyerCustodyRecovery({storage,scope,transport})})});
}
