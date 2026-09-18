// Immutable public package checks, shared by the browser and real TVM tests.
// No network, wallet, storage, or dependency imports in this module.
export const EXPECTED_CODE = '4a5dcc56c96ab4bfb1815242b3e696ee1a1663c9f1254c893455d47bb746dc2b';
export const EXPECTED_ITEM = 'ba4d975d2b66231c1f0a0ccca6e8ff8f7ba0610c4b7639584b8e98303dc3128c';
export const EXPECTED_OWNER = '0:6ea2cc995c7d4f236441c6c520b236c3e919ec54e331b4269528428c651a5717';
export const PACKAGE_SHA256 = '385d5550ff4cb83422e2ff052e958225aa859729f9ba7adfb0a7a04825977e2c';
export const REVEAL_AT = 1798761600;
export const requireThat=(ok,message)=>{if(!ok)throw Error(message);};
const hash=c=>c.hash().toString('hex');
const empty=s=>s.remainingBits===0&&s.remainingRefs===0;
export function parseData(cell){
 const s=cell.beginParse();
 const d={owner:s.loadAddress(),next:s.loadUintBig(64),content:s.loadRef(),item:s.loadRef(),royalty:s.loadRef(),treasury:s.loadAddress(),paused:s.loadBit(),revealed:s.loadBit(),commitment:s.loadUintBig(256)};
 requireThat(empty(s),'Extra collection fields');return d;
}
export function verifyPackage(core,p){
 const {Cell,Address,loadStateInit,contractAddress}=core;
 requireThat(p.version==='committed-reveal-v1'&&p.network==='mainnet','Wrong candidate version/network');
 for(const [k,v] of Object.entries({supply:10000,priceNanoTon:7000000000,maxPerTransaction:50,royaltyBps:700,revealAt:REVEAL_AT,nextItemIndex:0,initialPaused:true,collectionRevision:'v3-glasses-correction-1'}))requireThat(p[k]===v,'Wrong policy: '+k);
 const s=Cell.fromBase64(p.stateInitBocBase64).beginParse(),init=loadStateInit(s);requireThat(empty(s),'Extra StateInit fields');
 const address=contractAddress(0,init),d=parseData(init.data);
 requireThat(hash(init.code)===EXPECTED_CODE&&p.collectionCodeHash===EXPECTED_CODE,'Collection code mismatch');
 requireThat(address.toRawString()===p.collectionAddressRaw,'Calculated collection address mismatch');
 requireThat(d.owner.toRawString()===EXPECTED_OWNER&&d.treasury.toRawString()===EXPECTED_OWNER&&p.ownerAddressRaw===EXPECTED_OWNER&&p.treasuryAddressRaw===EXPECTED_OWNER,'Wrong beneficiary');
 requireThat(d.next===0n&&d.paused&&!d.revealed&&d.commitment>0n,'Unsafe initial state');
 requireThat(p.finalContentCommitment===d.commitment.toString(16).padStart(64,'0')&&/^[a-f0-9]{64}$/.test(p.releaseManifestSha256)&&/^[a-f0-9]{64}$/.test(p.releaseCarSha256),'Missing final commitment');
 requireThat(hash(d.item)===EXPECTED_ITEM&&p.nftItemCodeHash===EXPECTED_ITEM,'NFT code mismatch');
 const rs=d.royalty.beginParse();requireThat(rs.loadUint(16)===7&&rs.loadUint(16)===100&&rs.loadAddress().toRawString()===EXPECTED_OWNER&&empty(rs),'Wrong royalty');
 const cs=d.content.beginParse();requireThat(cs.remainingBits===0&&cs.remainingRefs===2,'Wrong hidden content');
 const cc=cs.loadRef().beginParse();requireThat(cc.loadUint(8)===1&&cc.loadStringTail()===p.collectionMetadataIpfs,'Hidden collection URI mismatch');
 requireThat(cs.loadRef().beginParse().loadStringTail()===p.preRevealMetadataRootIpfs,'Hidden item URI mismatch');
 for(const [k,bounce] of [['collectionAddressMainnetBounceable',true],['collectionAddressMainnetNonBounceable',false]]){
  const f=Address.parseFriendly(p[k]);requireThat(f.address.equals(address)&&f.isTestOnly===false&&f.isBounceable===bounce,'Incorrect mainnet address flag');
 }
 requireThat(p.creatorReservation?.tokenIndex===0&&p.creatorReservation.beneficiaryAddressRaw===EXPECTED_OWNER&&p.creatorReservation.opcode==='0x52535630','Creator reservation mismatch');
 const dep=p.tonConnectDeployMessage,cl=p.tonConnectCreatorClaimRequest;
 requireThat(dep.address===p.collectionAddressMainnetNonBounceable&&dep.amount==='300000000'&&dep.stateInit===p.stateInitBocBase64&&empty(Cell.fromBase64(dep.payload).beginParse()),'Wrong deployment request');
 requireThat(cl.network==='-239'&&cl.from===EXPECTED_OWNER&&cl.messages?.length===1,'Wrong creator request');
 const m=cl.messages[0],b=Cell.fromBase64(m.payload).beginParse();
 requireThat(m.address===p.collectionAddressMainnetBounceable&&m.amount==='7100000000'&&!m.stateInit&&b.loadUint(32)===0x52535630&&b.loadUintBig(64)===0n&&empty(b),'Wrong creator message');
 for(const k of ['bundleCid','finalMetadataRootIpfs','finalCollectionMetadataIpfs','contentBoc','seed','mnemonic','privateKey'])requireThat(!(k in p),'Private field in public package');
 return {address,init,data:d};
}
export function verifyLive(core,p,info){
 const expected=verifyPackage(core,p);
 requireThat(info?.state==='active'&&info.code&&info.data,'Contract is not active');
 requireThat(hash(core.Cell.fromBase64(info.code))===EXPECTED_CODE,'Live collection code mismatch');
 const d=parseData(core.Cell.fromBase64(info.data));
 requireThat(d.next>=0n&&d.next<=10000n&&d.owner.toRawString()===EXPECTED_OWNER&&d.treasury.toRawString()===EXPECTED_OWNER&&d.commitment===expected.data.commitment,'Live policy/beneficiary/commitment mismatch');
 requireThat(hash(d.item)===EXPECTED_ITEM&&hash(d.royalty)===hash(expected.data.royalty),'Live item/royalty mismatch');
 requireThat(hash(d.content)===(d.revealed?p.finalContentCommitment:hash(expected.data.content)),'Live metadata differs');return d;
}
export function itemAddress(core,p,index){
 requireThat(Number.isInteger(index)&&index>=0&&index<10000,'Bad item index');
 const {init,address,data}=verifyPackage(core,p);
 return core.contractAddress(0,{code:data.item,data:core.beginCell().storeUint(index,64).storeAddress(address).endCell()});
}
export function verifyItem(core,p,info,index,ownerRaw){
 requireThat(info?.state==='active'&&info.code&&info.data,'NFT is not initialized');
 requireThat(hash(core.Cell.fromBase64(info.code))===EXPECTED_ITEM,'NFT code differs');
 const s=core.Cell.fromBase64(info.data).beginParse();
 requireThat(s.loadUintBig(64)===BigInt(index)&&s.loadAddress().toRawString()===p.collectionAddressRaw&&s.loadAddress().toRawString()===ownerRaw,'Wrong NFT index/collection/owner');
 requireThat(s.loadRef().beginParse().loadStringTail()===String(index).padStart(4,'0')+'.json'&&empty(s),'Wrong NFT suffix');return true;
}
export function testnetRequest(core,p,action,wallet,state,queryId=0n,nowSeconds=Math.floor(Date.now()/1000)){
 verifyPackage(core,p);
 requireThat(wallet?.account?.chain==='-3'&&core.Address.parse(wallet.account.address).toRawString()===EXPECTED_OWNER,'Only the approved TESTNET wallet can sign');
 requireThat(state&&['uninitialized','active'].includes(state.status),'No checked state');
 const allowed=action==='deploy'?state.status==='uninitialized':state.status==='active'&&(action==='claim'?state.next===0&&state.paused:action==='open'?state.next===1&&state.paused&&state.creatorVerified:action==='mint'?state.next===1&&!state.paused&&state.creatorVerified:false);
 requireThat(allowed,'Action not permitted');
 const address=core.Address.parse(p.collectionAddressRaw).toString({bounceable:action!=='deploy',testOnly:true});
 let message;
 if(action==='deploy')message={...p.tonConnectDeployMessage,address};
 else{const opcode={claim:0x52535630,open:0x554e5053,mint:0x4d494e54}[action];let b=core.beginCell().storeUint(opcode,32).storeUint(queryId,64);if(action==='mint')b=b.storeUint(1,8);
 message={address,amount:action==='open'?'50000000':'7100000000',payload:b.endCell().toBoc().toString('base64')};}
 return {network:'-3',from:EXPECTED_OWNER,validUntil:nowSeconds+300,messages:[message]};
}
