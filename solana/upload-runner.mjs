// No background signing on page load. Called only by the Continue button.
export async function runUpload(client,{size=10,stopped=()=>false,onProgress=()=>{},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  let sign=false,waits=0;
  while(!stopped()){
    const r=await client.groupStep({size,sign,stopped,onPhase:onProgress});
    onProgress(r);
    if(['complete','retry-available','stopped'].includes(r.status))return r;
    if(r.status==='pending'||r.status==='submitted'){
      sign=false;
      if(++waits>=60)return {status:'waiting',loaded:r.loaded};
      await sleep(3000);
    }else{
      waits=0;sign=true;
    }
  }
  return {status:'stopped'};
}
