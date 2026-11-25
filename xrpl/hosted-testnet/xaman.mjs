// Xaman SDK maps the OAuth JWT ping's client_id to the application's public UUID.
export async function authenticatedBuyer(bearer, clientId, buyer, fetchProvider=fetch) {
  if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(clientId || '') ||
      typeof bearer !== 'string' || bearer.length>8192 ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer)) return false;
  // Workers supports manual redirects; the non-OK check below rejects a redirect before any token is forwarded.
  const options={headers:{Authorization:bearer,Accept:'application/json'},redirect:'manual',
    cache:'no-store',signal:AbortSignal.timeout(10000)};
  const read=async url=>{
    const response=await fetchProvider(url,options);
    if (response.status===401 || response.status===403) return null;
    if (!response.ok) throw Error('Xaman authentication unavailable');
    return response.json();
  };
  const [ping,profile]=await Promise.all([read('https://xumm.app/api/v1/jwt/ping'),read('https://oauth2.xumm.app/userinfo')]);
  return ping?.client_id?.toLowerCase()===clientId.toLowerCase() &&
    Number.isFinite(ping.exp) && ping.exp>Date.now()/1000 && profile?.account===buyer &&
    profile.networkType?.toUpperCase()==='TESTNET' && !profile.blocked;
}
