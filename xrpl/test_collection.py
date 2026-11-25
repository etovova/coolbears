import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from xrpl.wallet import Wallet
from xrpl.core.keypairs import sign
import inventory as inv
import testnet_collection as collection
import testnet_signer as agent


class SignedOrders(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = inv.connect(Path(self.dir.name)/'test.sqlite')
        self.addCleanup(self.db.close)
        inv.initialize(self.db,3)
        self.key = str(uuid.uuid4())
        self.who = collection.BUYERS[0]
        inv.claim(self.db,self.who,self.key,40)
        self.draft = {"TransactionType":collection.MINT,"Account":collection.ISSUER,"Sequence":13,
                      "LastLedgerSequence":90,"Fee":"10","Flags":8,"TransferFee":7000,"NFTokenTaxon":20270201,
                      "Expiration":777,"URI":collection.uri(3),"Destination":self.who,"Amount":collection.PRICE}
        self.h = "F"*64
        self.db.execute("INSERT INTO signed(hash,request,blob,draft,first_ledger) VALUES(?,?,?,?,?)",
                        (self.h,self.key,"blob",json.dumps(self.draft),50))

    def tx(self):
        fields={"Amount":collection.PRICE,"Owner":collection.ISSUER,"Destination":self.who,
                "NFTokenID":"T","Flags":1,"Expiration":777}
        return {"validated":True,"tx_json":self.draft,"hash":self.h,"ledger_index":80,"meta":{
                "TransactionResult":"tesSUCCESS","AffectedNodes":[{"CreatedNode":{"LedgerIndex":"O",
                "LedgerEntryType":"NFTokenOffer","NewFields":fields}}]}}

    def test_reopen_after_submission_checks_original_hash(self):
        with inv.connect(Path(self.dir.name)/'test.sqlite') as reopened:
            with patch.object(collection,"rpc",return_value=self.tx()),patch.object(collection,"validated_transaction") as submit:
                collection.reconcile_signed(reopened)
                collection.reconcile_signed(reopened)
                submit.assert_not_called()
        self.assertEqual(inv.order(self.db,self.key)["mint"],self.h)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM signed").fetchone()[0],1)

    def test_lost_signer_response_recovers_same_draft_on_reopen(self):
        self.db.execute("DELETE FROM signed")
        self.db.execute("INSERT INTO signing_draft VALUES(1,?,?,?)",(self.key,json.dumps(self.draft),50))
        with patch.object(collection,"snapshot",return_value={"seq":52}),patch.object(collection,"sign_draft",
             side_effect=TimeoutError("response lost")),self.assertRaises(TimeoutError):
            collection.resume_draft(self.db,None)
        with inv.connect(Path(self.dir.name)/"test.sqlite") as reopened:
            with patch.object(collection,"snapshot",return_value={"seq":53}),patch.object(collection,"sign_draft",
                 return_value=(self.h,"blob",json.dumps(self.draft))) as signer:
                collection.resume_draft(reopened,None)
                collection.resume_draft(reopened,None)
                signer.assert_called_once_with(None,self.draft)
            self.assertEqual(reopened.execute("SELECT hash FROM signed").fetchone()[0],self.h)
            self.assertEqual(reopened.execute("SELECT COUNT(*) FROM signing_draft").fetchone()[0],0)

    def test_missing_history_keeps_signed_action(self):
        with patch.object(collection,"snapshot",return_value={"seq":110}),patch.object(collection,"rpc",side_effect=[
                {"error":"txnNotFound"},{"error":"txnNotFound","searched_all":False}]):
            with self.assertRaises(inv.Conflict):
                collection.reconcile_signed(self.db)
        self.assertIsNone(self.db.execute('SELECT result FROM signed').fetchone()[0])

    def test_contiguous_history_with_unchanged_sequence_allows_recovery(self):
        with patch.object(collection,"snapshot",return_value={"seq":110,"hash":"L"}),patch.object(collection,"rpc",
                  side_effect=[{"error":"txnNotFound"},{"error":"txnNotFound","searched_all":True}]),patch.object(
                  collection,"snapshot_read",return_value={"account_data":{"Sequence":13}}):
            collection.reconcile_signed(self.db)
        self.assertEqual(self.db.execute('SELECT result FROM signed').fetchone()[0],'notApplied')
        self.assertEqual(inv.order(self.db,self.key)["phase"],"held")

    def test_incomplete_simulation_or_mismatched_receipt_cannot_sell(self):
        bad=self.tx();bad["meta"]["AffectedNodes"][0]["CreatedNode"]["NewFields"]["Amount"]="0"
        with patch.object(collection,"rpc",return_value=bad),self.assertRaises(ValueError):
            collection.reconcile_signed(self.db)
        with patch.object(collection,"rpc",return_value=self.tx()):
            collection.reconcile_signed(self.db)
        receipt={"offer":"O","token":"different","buyer":self.who,"hash":"A"*64}
        with self.assertRaises(ValueError):
            inv.atomic(self.db,collection.record_receipt,receipt)
        self.assertEqual(inv.order(self.db,self.key)["phase"],"open")
        receipt["token"]="T"
        inv.atomic(self.db,collection.record_receipt,receipt)
        inv.atomic(self.db,collection.record_receipt,receipt)
        self.assertEqual(inv.order(self.db,self.key)["payment"],receipt["hash"])

    def test_signer_budget_exact_price_and_operation_scope(self):
        self.assertEqual(agent.policy(self.draft,3,3),3)
        for change in ({"Account":"different"},{"Amount":"1"},{"URI":collection.uri(4)},{"Fee":"500"},
                       {"Flags":0},{"Destination":"another"},{"TransactionType":"Payment"},{"SetFlag":1}):
            with self.subTest(change=change),self.assertRaises(ValueError):
                agent.policy({**self.draft,**change},3,3)

    def test_wallet_proof_bound_to_order_wallet_and_site(self):
        wallet,other=Wallet.create(),Wallet.create()
        data={"buyer":wallet.address,"request":self.key,"publicKey":wallet.public_key}
        msg=f"CoolBears Testnet reservation\nSite {collection.ORIGIN}\nWallet {wallet.address}\nOrder {self.key}\nMaximum NFT price 10 test XRP"
        data.update(message=msg,signature=sign(msg.encode(),wallet.private_key))
        with patch.object(collection,"BUYERS",(wallet.address,other.address)):
            collection.authenticate(data)
            for change in ({"buyer":other.address},{"request":str(uuid.uuid4())},
                           {"signature":sign(msg.encode(),other.private_key)},{"message":msg.replace("18840","18841")}):
                with self.subTest(change=next(iter(change))),self.assertRaises(inv.Conflict):
                    collection.authenticate({**data,**change})


if __name__=="__main__":
    unittest.main()
