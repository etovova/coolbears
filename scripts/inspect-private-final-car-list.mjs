// Read-only Pinata private-file listing probe. Never prints IDs, CIDs, URLs or secrets.
import fs from 'node:fs';
import {client,requireThat} from './pinata-backup-io.mjs';
const NAME='CoolBears v3 FINAL CAR private verified';
const EXPECTED_MIN=10_000_000_000;
const jwt=process.env.PINATA_JWT;requireThat(jwt&&jwt.length>=32,'PINATA_SECRET_MISSING');
const api=client(jwt);
const j=await api.api('/v3/files/private?limit=100');
const d=j?.data;
const arrays=[];
if(Array.isArray(d)) arrays.push(d);
if(d&&typeof d==='object') for(const v of Object.values(d)) if(Array.isArray(v)) arrays.push(v);
const rows=arrays.sort((a,b)=>b.length-a.length)[0]||[];
const matches=rows.filter(x=>x&&x.name===NAME);
const plausible=matches.filter(x=>Number(x.size||0)>=EXPECTED_MIN&&x.network==='private'&&typeof x.id==='string'&&typeof x.cid==='string');
const result={schema:1,status:'PRIVATE_FINAL_CAR_LIST_PROBED',rootKeys:Object.keys(j||{}),dataKeys:d&&typeof d==='object'&&!Array.isArray(d)?Object.keys(d):[],rowsDetected:rows.length,exactNameMatches:matches.length,plausibleLargePrivateMatches:plausible.length,rowFieldNames:rows[0]&&typeof rows[0]==='object'?Object.keys(rows[0]):[],idsExposed:false,cidsExposed:false,urlsExposed:false,uploadsPerformed:false};
fs.mkdirSync('build/private-final-car-locator',{recursive:true});
fs.writeFileSync('build/private-final-car-locator/summary.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
