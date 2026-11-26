import {assert, ID} from './common.mjs';

async function readCheckpoint(bootstrap) {
  const decoded = Uint8Array.from(atob(bootstrap), c => c.charCodeAt(0));
  const stream = new Blob([decoded]).stream().pipeThrough(new DecompressionStream('deflate'));
  const snapshot = await new Response(stream).json();
  const {orders,slot,signed,setup} = snapshot;
  assert(setup.length === 1 && setup[0].previous === 3 && orders.length === 4 && signed.length === 4 && slot.length === 7);
  assert(orders.every(o => o.phase === 'sold' && ID.test(o.payment)) && signed.every(t => t.result === 'tesSUCCESS'));
  return snapshot;
}

export async function initialize(storage, bootstrap, afterReset = false) {
  const db = storage.sql;
  db.exec('CREATE TABLE IF NOT EXISTS setup(previous INTEGER NOT NULL)');
  if (db.exec('SELECT previous FROM setup').toArray().length) return;
  const {orders,slot,signed,setup} = afterReset
    ? {orders:[],slot:[],signed:[],setup:[{previous:0}]}
    : await readCheckpoint(bootstrap);
  storage.transactionSync(() => {
    db.exec(`CREATE TABLE slot(n INTEGER PRIMARY KEY CHECK(n BETWEEN 0 AND 9999),state TEXT NOT NULL,
      token TEXT UNIQUE,mint TEXT UNIQUE);`);
    db.exec(`CREATE TABLE orders(id TEXT PRIMARY KEY,buyer TEXT NOT NULL,n INTEGER NOT NULL,phase TEXT NOT NULL,
      expires INTEGER NOT NULL,offer TEXT UNIQUE,ledger INTEGER,payment TEXT UNIQUE)`);
    db.exec("CREATE UNIQUE INDEX active_buyer ON orders(buyer) WHERE phase IN ('held','open')");
    db.exec("CREATE UNIQUE INDEX active_slot ON orders(n) WHERE phase IN ('held','open')");
    db.exec('CREATE INDEX due ON orders(phase,expires)');
    db.exec(`CREATE TABLE signed(hash TEXT PRIMARY KEY,request TEXT NOT NULL,blob TEXT NOT NULL,draft TEXT NOT NULL,
      first_ledger INTEGER NOT NULL,result TEXT,ledger INTEGER)`);
    db.exec('CREATE UNIQUE INDEX pending ON signed((1)) WHERE result IS NULL');
    for (const r of slot) db.exec('INSERT INTO slot VALUES(?,?,?,?)',r.n,r.state,r.token,r.mint);
    for (const r of orders) db.exec('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?)',r.id,r.buyer,r.n,r.phase,r.expires,r.offer,r.ledger,r.payment);
    for (const r of signed) db.exec('INSERT INTO signed VALUES(?,?,?,?,?,?,?)',r.hash,r.request,r.blob,r.draft,r.first_ledger,r.result,r.ledger);
    db.exec('INSERT INTO setup VALUES(?)', setup[0].previous);
  });
}
export class Journal {
  constructor(storage) { this.storage = storage; this.db = storage.sql; }
  exec(sql,...params) {return this.db.exec(sql,...params);}
  first(sql,...params) {return this.exec(sql,...params).toArray()[0];}
  order(id) {
    return this.first('SELECT o.*,s.token,s.mint FROM orders o JOIN slot s USING(n) WHERE o.id=?',id);
  }
  pending() {return this.first('SELECT * FROM signed WHERE result IS NULL');}
  close(row, payment) {
    this.storage.transactionSync(() => {
      this.exec('UPDATE orders SET phase=?,payment=? WHERE id=?',payment?'sold':'expired',payment,row.id);
      this.exec('UPDATE slot SET state=? WHERE n=?',payment?'sold':'free',row.n);
    });
  }
  claim(buyer, request, close) {
    return this.storage.transactionSync(() => {
      let slot = this.first("SELECT n FROM slot WHERE state='free' ORDER BY (token IS NULL),n LIMIT 1");
      if (!slot) {
        slot = this.first('SELECT COALESCE(MAX(n),-1)+1 AS n FROM slot');
        if (slot.n >= 10000) return null;
        this.exec("INSERT INTO slot(n,state) VALUES(?,'held')",slot.n);
      } else this.exec("UPDATE slot SET state='held' WHERE n=?",slot.n);
      this.exec("INSERT INTO orders(id,buyer,n,phase,expires) VALUES(?,?,?,'held',?)",request,buyer,slot.n,close+300);
      return this.order(request);
    });
  }
}
