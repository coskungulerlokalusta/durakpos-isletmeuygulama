// node --test app/pos  — köprü ve deneme cihazı
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net');
const { PosBridge } = require('./bridge');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pos-'));
const sim = { driver: 'simulator', simDelayMs: 10, marka: 'TEST', model: 'SIM' };

test('tanımsız cihaz: satış yok, anlaşılır mesaj', async () => {
  const b = new PosBridge(tmp());
  assert.equal(b.status().configured, false);
  assert.equal((await b.sale({ txnId: 't', amount: 10 })).ok, false);
  b.close();
});

test('deneme cihazı: onay, red, vazgeçme; aynı işlem iki kez çekilmez', async () => {
  const b = new PosBridge(tmp()); b.configure(sim);
  await b.connect();
  assert.equal(b.status().connected, true);
  const ok = await b.sale({ txnId: 'a1', orderId: 5, amount: 120, payType: 'card' });
  assert.equal(ok.ok, true); assert.equal(ok.status, 'approved'); assert.ok(ok.receiptNo);
  const again = await b.sale({ txnId: 'a1', orderId: 5, amount: 120, payType: 'card' });
  assert.equal(again.repeated, true); assert.equal(again.receiptNo, ok.receiptNo);
  assert.equal((await b.sale({ txnId: 'a2', amount: 10.13 })).status, 'declined');
  assert.equal((await b.sale({ txnId: 'a3', amount: 10.77 })).status, 'cancelled');
  const p = await b.pending();
  assert.deepEqual(p.map(x => x.txnId), ['a1'], 'onaylı ama kasaya yazılmamış');
  b.ack('a1');
  assert.equal((await b.pending()).length, 0);
  b.close();
});

test('bağlantı koparsa ödeme askıda kalır, program yeniden açılınca bulunur', async () => {
  const dir = tmp();
  const b = new PosBridge(dir); b.configure(sim);
  const r = await b.sale({ txnId: 'k1', orderId: 9, amount: 55.66, payType: 'card' });
  assert.equal(r.status, 'unknown');
  b.close();
  // "Program yeniden açıldı": aynı günlük dosyası; deneme cihazının hafızası aynı modülde
  const b2 = new PosBridge(dir); b2.driver = b.driver; b2.config = b.config;
  const p = await b2.pending();
  assert.equal(p.length, 1); assert.equal(p[0].status, 'approved'); assert.equal(p[0].orderId, 9);
  b2.close();
});

test('Ingenico GMP-3: ağ kontrolü yapar, satışı desteklemez (kasa elle akışta kalır)', async () => {
  const srv = net.createServer(s => s.end()); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const b = new PosBridge(tmp());
  b.configure({ driver: 'ingenico_gmp3', ip: '127.0.0.1', port: srv.address().port, connection_type: 'ethernet' });
  const c = await b.connect();
  assert.equal(c.ok, true);
  assert.equal(b.status().capabilities.sale, false);
  assert.equal((await b.sale({ txnId: 'g1', amount: 10 })).status, 'unsupported');
  b.configure({ driver: 'ingenico_gmp3', ip: '127.0.0.1', port: 1, connection_type: 'ethernet' });
  const bad = await b.connect();
  assert.equal(bad.ok, false); assert.match(bad.error, /ulaşılamadı/);
  b.close(); srv.close();
});
