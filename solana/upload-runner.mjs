import { isRateLimit } from './rpc-pacing.mjs';

// Manual Devnet mode: one button press performs at most one 25-record group.
// A later button press reconciles a durable pending transaction; this runner
// never waits, retries, signs another group, or continues in the background.
export async function runUpload(client,{size=1,onProgress=()=>{}}={}) {
  if(size!==1)throw Error('Ручной режим поддерживает только одну группу до 25 записей.');
  let result;
  try {
    result=await client.groupStep({size:1,sign:true,onPhase:onProgress});
  } catch(error) {
    if(!isRateLimit(error))throw error;
    result={status:'rate-limited'};
  }
  onProgress(result);
  return result;
}
