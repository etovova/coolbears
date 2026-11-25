import concurrent.futures
import hashlib
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest

import inventory as inv


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest().upper()


class InventoryTests(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.path = pathlib.Path(d.name) / "inventory.sqlite"
        self.db = inv.connect(self.path)
        self.addCleanup(self.db.close)
        inv.initialize(self.db)

    def test_competing_claims_and_retries(self):
        def claim(i):
            db = inv.connect(self.path)
            try:
                return inv.claim(db, "wallet", "same", i)["n"]
            finally:
                db.close()
        with concurrent.futures.ThreadPoolExecutor(16) as pool:
            self.assertEqual(set(pool.map(claim, range(64))), {0})
        with self.assertRaises(inv.Conflict):
            inv.claim(self.db, "another", "same", 2)
        with self.assertRaises(inv.Conflict):
            inv.claim(self.db, "wallet", "new", 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM orders").fetchone()[0], 1)

    def test_process_exit_rolls_back_half_written_order(self):
        code = """import os, sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute("BEGIN IMMEDIATE")
db.execute("UPDATE slot SET state='held' WHERE n=0")
os._exit(23)"""
        p = subprocess.run([sys.executable, "-c", code, str(self.path)])
        self.assertEqual(p.returncode, 23)
        self.assertEqual(inv.claim(self.db, "wallet", "one", 10)["n"], 0)

    def test_expiry_recycles_token_and_protects_sold_request(self):
        inv.claim(self.db, "A", "one", 1)
        inv.atomic(self.db, inv.offered, "one", "nft", "mint", "offer1", 3, 100)
        inv.atomic(self.db, inv.close_order, "one", "expired")
        self.assertEqual(inv.claim(self.db, "A", "one", 101)["phase"], "expired")
        row = inv.claim(self.db, "B", "two", 102)
        self.assertEqual((row["n"],row["token"]),(0,"nft"))
        inv.atomic(self.db, inv.offered, "two", "nft", "mint", "offer2", 4, 200)
        inv.atomic(self.db, inv.close_order, "two", "sold", "payment")
        self.assertEqual(inv.claim(self.db, "B", "two", 900)["payment"], "payment")
        self.assertEqual(inv.claim(self.db, "A", "three", 901)["n"], 1)
        with self.assertRaises(ValueError):
            inv.atomic(self.db, inv.close_order, "two", "expired")

    def test_full_supply_with_sixteen_concurrent_writers_and_reopen(self):
        workers = 16
        barrier = threading.Barrier(workers)
        def batch(i):
            db = inv.connect(self.path)
            try:
                barrier.wait(20)
                for n in range(i,inv.SUPPLY,workers):
                    key, buyer = f"request-{n}", f"buyer-{n}"
                    slot = inv.claim(db, buyer, key, 1)["n"]
                    inv.atomic(db, inv.offered, key, digest(f"token{slot}"),digest(f"mint{slot}"),
                               digest(f"offer{n}"), 2, 150)
                    inv.atomic(db, inv.close_order, key, "sold", digest(f"pay{n}"))
                    if n % 41 == 0:
                        db.close()
                        db = inv.connect(self.path)
                        self.assertEqual(inv.claim(db,buyer,key,200)["payment"],digest(f"pay{n}"))
            finally:
                db.close()
        with concurrent.futures.ThreadPoolExecutor(workers) as pool:
            list(pool.map(batch,range(workers)))
        unique = self.db.execute("SELECT count(*),count(DISTINCT n),count(DISTINCT buyer),"
                                 "count(DISTINCT offer),count(DISTINCT payment) FROM orders WHERE phase='sold'").fetchone()
        self.assertEqual(tuple(unique),(inv.SUPPLY,)*5)
        self.assertEqual(tuple(self.db.execute("SELECT min(n),max(n),count(DISTINCT token),count(DISTINCT mint) "
                                               "FROM slot WHERE state='sold'").fetchone()),(0,9999,10000,10000))
        with self.assertRaises(inv.Conflict):
            inv.claim(self.db,"another wallet","extra",1000)
        self.assertEqual(self.db.execute("PRAGMA integrity_check").fetchone()[0],"ok")


if __name__ == "__main__":
    unittest.main(verbosity=2)
