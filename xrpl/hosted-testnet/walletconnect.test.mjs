import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeForSigning} from 'ripple-binary-codec';
import {deriveAddress,deriveKeypair,generateSeed,sign} from 'ripple-keypairs';
import {challenge,proof} from './proof.mjs';
import {walletAdapter,sessionBuyer} from '../web/walletconnect.mjs';
import {reservationEnvelope} from '../web/reservation-envelope.mjs';
import {handle} from '../worker.mjs';

const keys=deriveKeypair(generateSeed()), buyer=deriveAddress(keys.publicKey);
const testId='a'.repeat(32), offer='F'.repeat(64), topic='test-session';
const session={topic,expiry:Date.now()/1000 + 1000,namespaces:{xrpl:{
  methods:['xrpl_signTransaction'], accounts:['xrpl:1:'+buyer]}}};

test('WalletConnect exposes only a valid project ID, independently of sales and Xaman',async()=>{
  for(const [given,want] of [[undefined,null],['invalid',null],[testId,testId]]){
    const status=await (await handle(new Request('https://coolbears-nfts.com/xrpl/api/status'),
      {WALLETCONNECT_PROJECT_ID:given,XAMAN_CLIENT_ID:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'})).json();
    assert.equal(status.walletConnectProjectId,want);assert.ok(status.xamanClientId);
    assert.equal(status.open,false);assert.equal(status.price,'10000000');
  }
});
test('XRPL session must authorize the buyer, chain and signing method and be unexpired',()=>{
  assert.equal(sessionBuyer(session,'Testnet'),buyer);
  for(const [s,network] of [[session,'Mainnet'],[{...session,expiry:0},'Testnet'],
    [{...session,namespaces:{xrpl:{methods:[],accounts:['xrpl:1:'+buyer]}}},'Testnet']])
    assert.equal(sessionBuyer(s,network),null);
});
test('WalletConnect pairs, signs only an expired reservation and submits a single fixed-price offer',async()=>{
  const input={provider:'walletconnect',buyer,request:crypto.randomUUID()};
  const c=await challenge(input,'fixture',1000), calls=[], handlers={};
  const client={on:(event,fn)=>handlers[event]=fn, session:{getAll:()=>[],get:()=>session},
    async connect({requiredNamespaces}) {
      assert.deepEqual(requiredNamespaces.xrpl,{chains:['xrpl:1'],methods:['xrpl_signTransaction'],events:[]});
      return {uri:'wc:fixture',approval:async()=>session};
    },
    async request({topic:requestedTopic,chainId,request}) {
      assert.equal(requestedTopic,topic);assert.equal(chainId,'xrpl:1');assert.equal(request.method,'xrpl_signTransaction');
      const {tx_json,autofill,submit}=request.params;
      calls.push(tx_json.TransactionType);
      if(!submit){
        assert.equal(autofill,false);
        assert.deepEqual(tx_json,reservationEnvelope(buyer,c.message));
        assert.equal(tx_json.LastLedgerSequence,1);assert.equal(tx_json.Fee,'0');
        const fields={...tx_json,SigningPubKey:keys.publicKey};
        return {tx_json:{...fields,TxnSignature:sign(encodeForSigning(fields),keys.privateKey)}};
      }
      assert.equal(autofill,true);
      assert.deepEqual(tx_json,{TransactionType:'NFTokenAcceptOffer',Account:buyer,NFTokenSellOffer:offer,LastLedgerSequence:200});
      return {tx_json:{...tx_json,hash:'B'.repeat(64)}};
    }};
  const changes=[],shown=[];
  const wc=walletAdapter({origin:'https://testnet.coolbears-nfts.com',onChange:v=>changes.push(v),
    loadSdk:async()=>({SignClient:{init:async()=>client},qr:{toDataURL:async()=> 'local-QR'}})});
  const signal=new AbortController().signal;
  assert.equal(await wc.connect(testId,'Testnet',(...a)=>shown.push(a),signal),buyer);
  assert.deepEqual(shown,[['wc:fixture','local-QR']]);
  const signed={...input,...c,...await wc.signReservation('Testnet',buyer,c.message)};
  assert.equal(await proof(signed,'fixture',1010),true);
  assert.equal(await proof(signed,'fixture',1240),false);
  assert.equal(await proof({...signed,request:crypto.randomUUID()},'fixture',1010),false);
  const forged={...reservationEnvelope(buyer,c.message),SigningPubKey:keys.publicKey,LastLedgerSequence:200};
  assert.equal(await proof({...signed,signature:sign(encodeForSigning(forged),keys.privateKey)},'fixture',1010),false);
  const quote={price:'10000000',id:offer,validThrough:200};
  for(const patch of [{price:'1'},{id:'abc'},{validThrough:0}]) await assert.rejects(()=>wc.acceptOffer('Testnet',buyer,{...quote,...patch}));
  await assert.rejects(()=>wc.acceptOffer('Mainnet',buyer,quote));
  assert.equal(await wc.acceptOffer('Testnet',buyer,quote),'B'.repeat(64));
  handlers.session_delete({topic});assert.deepEqual(changes,[null]);
  await assert.rejects(()=>wc.acceptOffer('Testnet',buyer,quote));
  assert.deepEqual(calls,['AccountSet','NFTokenAcceptOffer']);
});
