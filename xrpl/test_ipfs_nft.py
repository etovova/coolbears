import json
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from ipfs_nft import DELEGATE, COVER, FEE, HIDDEN, ISSUER, REVEAL, TAXON, choose_root, encode_uri, metadata_uri, update_for_token


class IPFSReveal(unittest.TestCase):
    def test_before_and_at_reveal(self):
        self.assertEqual(choose_root(REVEAL-timedelta(seconds=1), None), HIDDEN)
        with self.assertRaises(ValueError):
            choose_root(REVEAL, None)
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp)/'revealed.json'
            report.write_text(json.dumps(dict(count=10000,traits=70000,metadata=COVER)))
            self.assertEqual(choose_root(REVEAL, report), COVER)

    def test_current_owner_and_idempotent_update(self):
        token = dict(flags=24, issuer=ISSUER,nft_taxon=TAXON,transfer_fee=FEE,is_burned=False,
                     owner='buyer',nft_id='A'*64,uri=encode_uri(metadata_uri(HIDDEN,12)))
        self.assertEqual(update_for_token(token,COVER,12)['Owner'], 'buyer')
        self.assertEqual(update_for_token(token,COVER,12)['Delegate'], DELEGATE)
        self.assertNotIn('Owner', update_for_token(dict(token,owner=ISSUER),COVER,12))
        with self.assertRaises(ValueError):
            update_for_token(token,COVER,13)
        with self.assertRaises(ValueError):
            update_for_token(dict(token,flags=8),COVER,12)
        token['uri'] = encode_uri(metadata_uri(COVER,12))
        self.assertIsNone(update_for_token(token,COVER,12))
