import {WorkerEntrypoint} from 'cloudflare:workers';
import {handleMainnetRpc} from './transport.mjs';
// The original deployed module is retained byte-for-byte, including all
// legacy default routing, RpcGate state/schema, limits and bundled licenses.
export {default,RpcGate} from './legacy-worker.js';
export class MainnetRpc extends WorkerEntrypoint {
  async fetch(request){return handleMainnetRpc(request,this.env);}
}
