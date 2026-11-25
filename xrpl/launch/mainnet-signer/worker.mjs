const proofPrefix = 'CoolBears / XRPL Mainnet / signer possession / v1 / ';

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/proof' || url.search) {
      return new Response(null, {status: 404});
    }

    // Only sign a server-generated proof. No request data is ever signed.
    const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
    const message = proofPrefix + nonce;
    const privateBytes = Uint8Array.from(atob(env.MAINNET_SIGNER_PKCS8), ch => ch.charCodeAt(0));
    let key;
    try {
      key = await crypto.subtle.importKey('pkcs8', privateBytes, 'Ed25519', false, ['sign']);
    } finally {
      privateBytes.fill(0);
    }
    const signature = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(message));
    return Response.json({publicKey: env.MAINNET_SIGNER_PUBLIC_KEY, message, signature: hex(new Uint8Array(signature))},
      {headers: {'Cache-Control': 'no-store'}});
  }
};
