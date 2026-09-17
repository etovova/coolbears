// Safe TUS protocol probe using a tiny non-NFT private file.
// It does not expose IDs/CIDs/URLs and never touches collection data.
import crypto from 'node:crypto';
import {client,requireThat} from './pinata-backup-io.mjs';
const NAME='CoolBears private TUS protocol probe v1';
const DATA=Buffer.from('CoolBears private TUS protocol probe v1\n','utf8');
const jwt=process.env.PINATA_JWT;requireThat(jwt&&jwt.length>=32,'PINATA_SECRET_MISSING');
const enc=v=>Buffer.from(v,'utf8').toString('base64');
const base='https://uploads.pinata.cloud/v3/files';
const result={schema:1,status:'TUS_PRIVATE_PROBE_NOT_COMPLETED',createStatus:null,patchStatus:null,listed:false,privateEndpoint:true,bytes:DATA.length,idsExposed:false,cidsExposed:false,urlsExposed:false,nftDataUsed:false};
try{
  const create=await fetch(base,{method:'POST',headers:{Authorization:'Bearer '+jwt,'Tus-Resumable':'1.0.0','Upload-Length':String(DATA.length),'Upload-Metadata':`filename ${enc('coolbears-tus-probe.txt')},network ${enc('private')},name ${enc(NAME)}`},redirect:'manual',signal:AbortSignal.timeout(30000)});
  result.createStatus=create.status;
  requireThat(create.status===201,'TUS_CREATE_HTTP_'+create.status);
  const loc=create.headers.get('location');requireThat(loc,'TUS_LOCATION_MISSING');
  const u=new URL(loc,base);requireThat(u.protocol==='https:'&&u.hostname==='uploads.pinata.cloud'&&!u.username&&!u.password,'TUS_LOCATION_UNTRUSTED');
  const patch=await fetch(u.href,{method:'PATCH',headers:{Authorization:'Bearer '+jwt,'Tus-Resumable':'1.0.0','Upload-Offset':'0','Content-Type':'application/offset+octet-stream','Content-Length':String(DATA.length)},body:DATA,redirect:'manual',signal:AbortSignal.timeout(30000)});
  result.patchStatus=patch.status;
  requireThat(patch.status===204,'TUS_PATCH_HTTP_'+patch.status);
  requireThat(Number(patch.headers.get('upload-offset'))===DATA.length,'TUS_FINAL_OFFSET_MISMATCH');
  const api=client(jwt);
  for(let i=0;i<10;i++){
    const list=await api.api('/v3/files/private?limit=100');
    const rows=list?.data?.files;requireThat(Array.isArray(rows),'PRIVATE_LIST_SHAPE_MISMATCH');
    if(rows.some(x=>x?.name===NAME&&Number(x?.size||0)===DATA.length)){result.listed=true;break;}
    await new Promise(r=>setTimeout(r,1000));
  }
  requireThat(result.listed,'TUS_PRIVATE_FILE_NOT_LISTED');
  result.status='TUS_PRIVATE_PROTOCOL_VERIFIED';
}catch(e){result.error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'TUS_PROBE_ERROR';process.exitCode=1;}
console.log(JSON.stringify(result));
