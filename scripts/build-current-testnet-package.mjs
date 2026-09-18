// Derive an UNSIGNED TESTNET request from the exact current release bytecode/data.
// Does not compile legacy contracts, contact RPC, sign, deploy, claim or mint.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as core from '@ton/core';
import {verifyPackage,PACKAGE_SHA256} from '../launch/package-tools.mjs';
const bytes=fs.readFileSync('launch/candidate.json'),p=JSON.parse(bytes);
assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),PACKAGE_SHA256);
const v=verifyPackage(core,p);
const bounce=v.address.toString({testOnly:true,bounceable:true}),nonBounce=v.address.toString({testOnly:true,bounceable:false});
const out={...p,network:'testnet',status:'UNSIGNED_NOT_DEPLOYED',sourceMainnetPackageSha256:PACKAGE_SHA256,collectionAddressTestnetBounceable:bounce,collectionAddressTestnetNonBounceable:nonBounce,
  tonConnectDeployMessage:{...p.tonConnectDeployMessage,address:nonBounce},
  tonConnectCreatorClaimRequest:{...p.tonConnectCreatorClaimRequest,network:'-3',messages:[{...p.tonConnectCreatorClaimRequest.messages[0],address:bounce}]}
};
delete out.collectionAddressMainnetBounceable;delete out.collectionAddressMainnetNonBounceable;
delete out.ownerAddressMainnetFriendly;delete out.treasuryAddressMainnetFriendly;
assert.equal(out.stateInitBocBase64,p.stateInitBocBase64);
for(const m of [out.tonConnectDeployMessage,...out.tonConnectCreatorClaimRequest.messages]){
  const f=core.Address.parseFriendly(m.address);assert.equal(f.isTestOnly,true);assert.ok(f.address.equals(v.address));
}
assert.equal(out.tonConnectCreatorClaimRequest.network,'-3');
fs.mkdirSync('build/current-testnet',{recursive:true});
fs.writeFileSync('build/current-testnet/deployment.json',JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({status:out.status,network:out.network,sourceMainnetPackageSha256:PACKAGE_SHA256,address:nonBounce,unchangedStateInit:true,transactionsSent:0}));
