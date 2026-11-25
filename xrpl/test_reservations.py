"""Boundary and recovery checks for the local expiring-offer pilot."""
import json
import sqlite3
import unittest
from unittest.mock import patch

import testnet_reservations as pilot


class ReservationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.execute("CREATE TABLE action(hash TEXT,blob TEXT,draft TEXT,ledger INTEGER,offer TEXT,token TEXT)")
        self.draft = {"TransactionType": pilot.MINT, "Destination": pilot.BUYERS[0], "Expiration": 1200}
        self.db.execute("INSERT INTO action VALUES(?,?,?,?,?,?)", ("H", "blob", json.dumps(self.draft), 8, "ID", "NFT"))
        self.patch("snapshot", return_value={"seq": 12, "hash": "L"})
        self.owner = self.patch("holds_token", return_value=True)
        self.clock = self.patch("snapshot_read", return_value={"ledger": {"close_time": 1100}})
        self.node = self.patch("read_offer", return_value={"LedgerEntryType": "NFTokenOffer", "Owner": pilot.ISSUER,
                               "Flags": 1, "Amount": pilot.PRICE, "Destination": pilot.BUYERS[0],
                               "NFTokenID": "NFT", "Expiration": 1200})
        self.stage = self.patch("stage", side_effect=StopIteration)

    def patch(self, method, **kwargs):
        p = patch.object(pilot, method, **kwargs)
        self.addCleanup(p.stop)
        return p.start()

    def reserve(self, who=0):
        return pilot.reserve(self.db, None, pilot.BUYERS[who])

    def test_live_offer_is_unique_and_private(self):
        self.assertEqual(self.reserve()["id"], "ID")
        self.assertEqual(self.reserve(1)["status"], 409)
        self.stage.assert_not_called()

    def test_last_signing_minute_remains_reserved(self):
        self.clock.return_value["ledger"]["close_time"] = 1140
        self.assertEqual(self.reserve()["status"], 409)
        self.stage.assert_not_called()

    def test_expiry_stages_only_cancellation(self):
        self.clock.return_value["ledger"]["close_time"] = 1200
        with self.assertRaises(StopIteration):
            self.reserve(1)
        self.assertEqual(self.stage.call_args.args[-1], {"TransactionType": pilot.CANCEL, "NFTokenOffers": ["ID"]})

    def test_new_offer_uses_original_token_after_confirmed_cancel(self):
        self.db.execute("INSERT INTO action VALUES(?,?,?,?,?,?)", ("C", "blob", "{}", 9, None, None))
        with self.assertRaises(StopIteration):
            self.reserve(1)
        transaction = self.stage.call_args.args[-1]
        self.assertEqual(transaction["NFTokenID"], "NFT")
        self.assertEqual(transaction["TransactionType"], pilot.LIST)
        self.assertEqual(transaction["Destination"], pilot.BUYERS[1])

    def test_sold_token_or_unknown_history_cannot_be_relisted(self):
        self.owner.return_value = False
        self.assertEqual(self.reserve(1)["status"], 410)
        self.owner.return_value = True
        self.node.return_value = None
        history = self.patch("removal_type", return_value=None)
        self.assertEqual(self.reserve(1)["status"], 409)
        history.return_value = "NFTokenAcceptOffer"
        self.assertEqual(self.reserve(1)["status"], 410)
        self.stage.assert_not_called()

    def test_confirmed_external_cancellation_allows_new_offer(self):
        self.node.return_value = None
        self.patch("removal_type", return_value=pilot.CANCEL)
        with self.assertRaises(StopIteration):
            self.reserve(1)
        self.assertEqual(self.stage.call_args.args[-1]["TransactionType"], pilot.LIST)

    def test_unconfirmed_transaction_is_resumed_before_deciding(self):
        self.db.execute("UPDATE action SET ledger=NULL")
        finish = self.patch("finish", side_effect=StopIteration)
        with self.assertRaises(StopIteration):
            self.reserve(1)
        self.assertEqual(finish.call_args.args[1]["hash"], "H")
        self.stage.assert_not_called()


if __name__ == "__main__":
    unittest.main()
