"""Prepare CoolBears IPFS links for minting and issuer-signed reveal transactions."""
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

HIDDEN = 'bafybeia6ru6nvpgyzbab7gnp4ne7l7652s4q5mk4cvqh7evump5ifcf7eu'
COVER = 'bafybeifkixx4vdoid2tpd6zmcgtw2c5h3onoobeixzjwqnvryc5enq2s6y'
REVEAL = datetime(2027, 2, 1, tzinfo=timezone.utc)
ISSUER = 'ra7rAR24tKDsbmaJmikRjgCpoPZtFHsaJr'
TAXON = 20270201
FEE = 7000


def metadata_uri(root, slot):
    if not re.fullmatch(r'bafybei[a-z2-7]{52}', root) or not 0 <= slot < 10000:
        raise ValueError('Invalid IPFS directory or collection slot')
    return f'ipfs://{root}/{slot:04d}.json'


def encode_uri(uri):
    return uri.encode('ascii').hex().upper()


def choose_root(when, report):
    if when < REVEAL:
        return HIDDEN
    if not report:
        raise ValueError('The verified reveal directory is required after the reveal date')
    data = json.loads(Path(report).read_bytes())
    if data['count'] != 10000 or data['traits'] != 70000 or data['metadata'] == HIDDEN:
        raise ValueError('Unexpected IPFS release report')
    metadata_uri(data['metadata'], 0)
    return data['metadata']


def check_gateway(root, slot):
    # Fetch a token only from the selected phase. Never disclose a private final CID early.
    gateway = 'https://ipfs.io/ipfs/'
    with urlopen(gateway + metadata_uri(root, slot).removeprefix('ipfs://'), timeout=20) as response:
        meta = json.loads(response.read(65536))
    image = meta['image']
    if not re.fullmatch(r'ipfs://b[a-z2-7]{58}', image):
        raise ValueError('Expected a content-addressed image')
    if root == HIDDEN and (image != 'ipfs://'+COVER or meta['name'] != f'CoolBears #{slot:04d} — Hidden Bear'):
        raise ValueError('Hidden metadata mismatch')
    with urlopen(gateway + image.removeprefix('ipfs://'), timeout=20) as response:
        prefix = response.read(8)
    if not (prefix.startswith(b'GIF8') if root == HIDDEN else prefix == b'\x89PNG\r\n\x1a\n'):
        raise ValueError('The referenced artwork is unavailable')


def update_for_token(token, root, slot):
    if (token['issuer'], token['nft_taxon'], token['flags'], token['transfer_fee'], token.get('is_burned')) != (
            ISSUER, TAXON, 24, FEE, False):
        raise ValueError('Unexpected collection token')
    final = encode_uri(metadata_uri(root, slot))
    if token['uri'].upper() == final:
        return None
    if token['uri'].upper() != encode_uri(metadata_uri(HIDDEN, slot)):
        raise ValueError('Slot or current NFT URI mismatch')
    tx = {'TransactionType':'NFTokenModify', 'Account':ISSUER, 'NFTokenID':token['nft_id'], 'URI':final}
    if token['owner'] != ISSUER:
        tx['Owner'] = token['owner']
    return tx


if __name__ == '__main__':
    import argparse
    from first_mint import rpc, successful
    p = argparse.ArgumentParser(description='Prepare an unsigned reveal for a validated NFT on Mainnet.')
    p.add_argument('token')
    p.add_argument('slot', type=int)
    p.add_argument('report', type=Path)
    a = p.parse_args()
    if not re.fullmatch('[0-9A-Fa-f]{64}', a.token):
        p.error('Expected an NFT ID')
    from first_mint import MAINNET_RPC
    from datetime import timedelta
    info = successful(rpc(MAINNET_RPC,'server_info'))['info']
    ledger = info['validated_ledger']
    if info['network_id'] != 0 or ledger['age'] > 30:
        p.error('Expected a current Mainnet ledger')
    hdr = successful(rpc(MAINNET_RPC,'ledger',ledger_hash=ledger['hash']))
    if not hdr.get('validated') or hdr['ledger']['ledger_hash'] != ledger['hash']:
        p.error('Unconfirmed ledger')
    closed = datetime(2000,1,1,tzinfo=timezone.utc) + timedelta(seconds=hdr['ledger']['close_time'])
    if closed < REVEAL:
        p.error('Reveal time has not arrived')
    root = choose_root(closed, a.report)
    obj = successful(rpc(MAINNET_RPC,'nft_info',nft_id=a.token,ledger_hash=ledger['hash']))
    if not obj.get('validated') or not 0 < obj['ledger_index'] <= ledger['seq'] or obj['nft_id'] != a.token.upper():
        p.error('Could not confirm the token at the selected ledger')
    tx = update_for_token(obj,root,a.slot)
    if tx:
        check_gateway(root, a.slot)
        check = successful(rpc(MAINNET_RPC,'simulate',tx_json=tx))
        if check.get('applied') is not False or check.get('engine_result') != 'tesSUCCESS':
            p.error('Reveal simulation failed')
    print(json.dumps(tx or {'state':'already_revealed'}))
