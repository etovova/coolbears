// Offline fail-closed tests for the corrected MAINNET owner launch client.
// No RPC request, wallet, signature or transaction.
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {preparedFixture} from './release-test-fixtures.mjs';
import {validateLaunch,canOperate,PACKAGE_SHA256,REVISION,CANDIDATE_HASH} from '../release-guard.mjs';

const candidateBytes=fs.readFileSync('launch/candidate.json');
const deploymentBytes=fs.readFileSync('mainnet/owner/deployment.json');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
assert.equal(sha(candidateBytes),PACKAGE_SHA256);
assert.equal(sha(deploymentBytes),PACKAGE_SHA256);
assert.deepEqual(deploymentBytes,candidateBytes,'Owner deployment package must be byte-identical to launch/candidate.json');

const p=JSON.parse(candidateBytes);
assert.equal(p.collectionRevision,REVISION);
assert.equal(p.collectionCodeHash,CANDIDATE_HASH);
assert.equal(p.tonConnectDeployMessage.amount,'300000000');
assert.equal(p.tonConnectDeployMessage.stateInit,p.stateInitBocBase64);
assert.equal(p.tonConnectCreatorClaimRequest.network,'-239');
assert.equal(p.tonConnectCreatorClaimRequest.messages.length,1);
assert.equal(p.tonConnectCreatorClaimRequest.messages[0].amount,'7100000000');
assert.equal(p.initialPaused,true);
assert.equal(p.nextItemIndex,0);
assert.equal(p.automaticRevealEnabled,false);

const ctx=vm.createContext({window:{},document:{addEventListener(){}}});
vm.runInContext(fs.readFileSync('config.js','utf8'),ctx);
const cfg=ctx.window.COOLBEARS_CONFIG;
assert.equal(cfg.demoMode,true);
assert.equal(cfg.collectionAddress,p.collectionAddressMainnetNonBounceable);
assert.equal(cfg.mintContractAddress,p.collectionAddressMainnetBounceable);
assert.equal(cfg.collectionCodeHash,p.collectionCodeHash);

const source=fs.readFileSync('mainnet/owner/owner.js','utf8');
assert.ok(source.includes('@ton/core@0.63.1'),'Owner client must pin corrected TON core version');
assert.ok(source.includes(PACKAGE_SHA256),'Owner client must pin corrected package SHA');
assert.ok(source.includes("const REVISION='v3-glasses-correction-1'"),'Owner client must pin corrected revision');
assert.ok(source.includes("../../launch/candidate.json"),'Owner client must cross-check public candidate');
assert.ok(source.includes("deploy.amount!=='300000000'"),'Owner client must require corrected 0.30 TON deploy request');
assert.ok(source.includes("const paused=s.loadBit(),revealed=s.loadBit(),commitment=s.loadUintBig(256)"),'Owner client must parse full reveal-aware state');
assert.ok(source.includes("commitment!==BigInt('0x'+d.finalContentCommitment)"),'Owner client must verify final content commitment');
assert.ok(source.includes("releaseState?.publicMintApproved===true"),'Owner client must require explicit public mint approval before unpause');
assert.ok(!source.includes('9fc5ea62b3c0ad943cec55deef509bdf9fabafa2cca0616f74f4fae46587f231'),'Old code hash must not remain in owner client');
assert.ok(!source.includes('UQCaIEXpRw1EJzn6juFRXsywl9MWZ7QvlmkrA6_67ta2clK-'),'Old collection address must not remain in owner client');

const state=JSON.parse(fs.readFileSync('release/launch-state.json','utf8'));
const prepared=preparedFixture(state,p);
delete prepared.evidence.correctedMainnetDeployment;
delete prepared.evidence.correctedMainnetCreatorNft0000;
const gate=validateLaunch({...cfg,demoMode:true},p,prepared,PACKAGE_SHA256);
assert.deepEqual(gate,{phase:'prepared',setup:true,sales:false,automaticReveal:false});
assert.equal(canOperate('deploy',gate,{status:'uninitialized'},true),true);
assert.equal(canOperate('claim',gate,{status:'active',minted:0,paused:true,creatorVerified:false},true),true);
assert.equal(canOperate('unpause',gate,{status:'active',minted:1,paused:true,creatorVerified:true},true),false);
assert.equal(canOperate('deploy',gate,{status:'uninitialized'},false),false);

const html=fs.readFileSync('mainnet/owner/index.html','utf8');
assert.ok(html.includes('0,30 TON'));
assert.ok(html.includes('publicMintApproved=true'));
assert.ok(html.includes('Публичные продажи всё ещё выключены'));

console.log(JSON.stringify({
  suite:'corrected-mainnet-owner-launch',
  packageSha256:PACKAGE_SHA256,
  deploymentByteIdentical:true,
  demoMode:true,
  preparedDeployAllowed:true,
  preparedClaimAllowed:true,
  preparedUnpauseAllowed:false,
  realNetworkRequests:0,
  transactionsSent:0
}));
