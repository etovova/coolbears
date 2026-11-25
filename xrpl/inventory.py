"""Durable order identities and slot allocation. Network operations belong to the issuer worker."""
import sqlite3

SUPPLY = 10_000


class Conflict(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


def connect(path):
    db = sqlite3.connect(path, timeout=45, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db


def initialize(db, previous=0):
    if not 0 <= previous < SUPPLY:
        raise ValueError("Invalid existing inventory")
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS slot(
            n INTEGER PRIMARY KEY CHECK(n BETWEEN 0 AND 9999),
            state TEXT NOT NULL CHECK(state IN ('previous','free','held','sold')),
            token TEXT UNIQUE, mint TEXT UNIQUE);
        CREATE INDEX IF NOT EXISTS available ON slot(state,(token IS NULL),n);
        CREATE TABLE IF NOT EXISTS orders(
            id TEXT PRIMARY KEY,buyer TEXT NOT NULL,n INTEGER NOT NULL REFERENCES slot(n),
            phase TEXT NOT NULL CHECK(phase IN ('held','open','expired','sold')),expires INTEGER NOT NULL,
            offer TEXT UNIQUE,ledger INTEGER,payment TEXT UNIQUE);
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_buyer ON orders(buyer) WHERE phase IN ('held','open');
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_slot ON orders(n) WHERE phase IN ('held','open');
        CREATE INDEX IF NOT EXISTS due ON orders(phase,expires);
        CREATE TABLE IF NOT EXISTS signing_draft(
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),request TEXT NOT NULL REFERENCES orders(id),
            draft TEXT NOT NULL,first_ledger INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS signed(
            hash TEXT PRIMARY KEY,request TEXT NOT NULL REFERENCES orders(id),blob TEXT NOT NULL,
            draft TEXT NOT NULL,first_ledger INTEGER NOT NULL,result TEXT,ledger INTEGER);
        CREATE UNIQUE INDEX IF NOT EXISTS one_pending_issuer_tx ON signed((1)) WHERE result IS NULL;
        CREATE TABLE IF NOT EXISTS setup(previous INTEGER NOT NULL);
    """)
    db.execute("BEGIN IMMEDIATE")
    try:
        params = db.execute("SELECT previous FROM setup").fetchone()
        if not params:
            db.execute("INSERT INTO setup VALUES(?)", (previous,))
            db.executemany("INSERT INTO slot(n,state) VALUES(?,?)",
                           ((n, "previous" if n < previous else "free") for n in range(SUPPLY)))
        elif params[0] != previous:
            raise ValueError("Inventory origin differs from the persisted configuration")
        db.commit()
    except BaseException:
        db.rollback()
        raise


def order(db, key):
    return db.execute("SELECT o.*,s.token,s.mint FROM orders o JOIN slot s USING(n) WHERE o.id=?", (key,)).fetchone()


def claim(db, buyer, key, now, hold_seconds=300):
    db.execute("BEGIN IMMEDIATE")
    try:
        prior = order(db, key)
        if prior:
            if prior["buyer"] != buyer:
                raise Conflict("Request belongs to a different wallet", 403)
        else:
            active = db.execute("SELECT id FROM orders WHERE buyer=? AND phase IN ('held','open')", (buyer,)).fetchone()
            if active:
                raise Conflict("This wallet already has an active reservation.")
            slot = db.execute("SELECT n FROM slot WHERE state='free' ORDER BY (token IS NULL),n LIMIT 1").fetchone()
            if slot is None:
                raise Conflict("All slots are sold or reserved.")
            db.execute("UPDATE slot SET state='held' WHERE n=?", (slot[0],))
            db.execute("INSERT INTO orders(id,buyer,n,phase,expires) VALUES(?,?,?,'held',?)",
                       (key, buyer, slot[0], now + hold_seconds))
        answer = order(db, key)
        db.commit()
        return answer
    except BaseException:
        db.rollback()
        raise


def offered(db, key, token, mint, offer, ledger, expiry):
    """Called inside the transaction which records a validated issuer action."""
    row = order(db, key)
    if not row or row["phase"] != "held" or row["token"] not in (None, token) or row["mint"] not in (None, mint):
        raise ValueError("Unexpected issued NFT")
    db.execute("UPDATE slot SET token=?,mint=? WHERE n=?", (token, mint, row["n"]))
    db.execute("UPDATE orders SET phase='open',offer=?,ledger=?,expires=? WHERE id=?", (offer, ledger, expiry, key))


def close_order(db, key, phase, payment=None):
    """Expiry is applied only after the issuer has reconciled any signed operation."""
    if phase not in ("expired", "sold") or bool(payment) != (phase == "sold"):
        raise ValueError("Unexpected terminal outcome")
    row = order(db, key)
    if row["phase"] == phase and row["payment"] == payment:
        return
    if row["phase"] not in ("open", "held") or (phase == "sold" and row["phase"] != "open"):
        raise ValueError("Order already closed or never offered")
    db.execute("UPDATE orders SET phase=?,payment=? WHERE id=?", (phase, payment, key))
    db.execute("UPDATE slot SET state=? WHERE n=?", ("sold" if payment else "free", row["n"]))


def atomic(db, function, *args):
    db.execute("BEGIN IMMEDIATE")
    try:
        result = function(db, *args)
        db.commit()
        return result
    except BaseException:
        db.rollback()
        raise
