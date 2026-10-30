// DurakPOS yazarkasa POS köprüsü (masaüstü programı içinde çalışır).
//
// Kasa sayfası → (IPC) → bu köprü → sürücü → cihaz (Ingenico, Beko, ...)
//
// - Her işletme Panel'de kendi cihazını tanımlar (marka, model, IP, port,
//   sürücü). Kasa açılınca bu ayarları köprüye verir; sürücü seçiliyse kart
//   ödemesi kendiliğinden cihaza gider.
// - Sürücüler: 'simulator' (deneme cihazı), 'ingenico_gmp3' (GMP-3 —
//   entegrasyon kodları gelene kadar sadece ağ bağlantısını kontrol eder).
// - Askıda ödeme: her işlem cihaza gönderilmeden ÖNCE diske yazılır (günlük).
//   Program/bağlantı işlemin ortasında koparsa, açılışta ya da "Askıda Ödeme
//   Kontrolü" ile cihaza sorulur; onaylanmış ama DurakPOS'a yazılmamış ödeme
//   kaybolmaz.
// - Otomatik yeniden bağlanma: cihaz 15 sn'de bir yoklanır.
const fs = require('fs');
const path = require('path');
const { createSimulator } = require('./drivers/simulator');
const { createIngenicoGmp3 } = require('./drivers/ingenico-gmp3');

const DRIVERS = {
  simulator: createSimulator,
  ingenico_gmp3: createIngenicoGmp3,
};

const DRIVER_LABELS = {
  simulator: 'Deneme cihazı (simülatör)',
  ingenico_gmp3: 'Ingenico (GMP-3)',
};

const HEALTH_MS = 15000;
const round2 = n => Math.round(Number(n || 0) * 100) / 100;

class PosBridge {
  constructor(dataDir, opts = {}) {
    this.journalFile = path.join(dataDir, 'pos-journal.json');
    this.config = null;
    this.driver = null;
    this.state = { connected: false, lastError: null, checkedAt: null };
    this.busy = false;
    this.healthMs = opts.healthMs || HEALTH_MS;
    this.timer = null;
    this.journal = this._loadJournal();
  }

  // ---- Günlük (askıda ödemeler) ----
  _loadJournal() {
    try { return JSON.parse(fs.readFileSync(this.journalFile, 'utf8')) || []; } catch (e) { return []; }
  }
  _saveJournal() {
    // Onaylanıp kasaya iletilmiş (ack) eski kayıtlar 7 gün sonra silinir
    const cutoff = Date.now() - 7 * 86400e3;
    this.journal = this.journal.filter(j => !(j.acked && j.createdAt < cutoff)).slice(-500);
    const tmp = this.journalFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.journal, null, 1));
    fs.renameSync(tmp, this.journalFile); // yarım yazılmış dosya kalmasın
  }
  _entry(id) { return this.journal.find(j => j.txnId === id); }

  // ---- Ayar ----
  configure(cfg) {
    const c = cfg || {};
    const driverKey = DRIVERS[c.driver] ? c.driver : null;
    const same = this.config && this.driver && JSON.stringify(this.config) === JSON.stringify({ ...c, driver: driverKey });
    if (same) return this.status();
    this._stopHealth();
    if (this.driver && this.driver.close) { try { this.driver.close(); } catch (e) {} }
    this.config = { ...c, driver: driverKey };
    this.driver = driverKey ? DRIVERS[driverKey](this.config) : null;
    this.state = { connected: false, lastError: null, checkedAt: null };
    if (this.driver) { this._startHealth(); this.connect().catch(() => {}); }
    return this.status();
  }

  status() {
    const caps = this.driver ? this.driver.capabilities : {};
    return {
      configured: !!this.driver,
      driver: this.config && this.config.driver,
      driverLabel: this.config && DRIVER_LABELS[this.config.driver],
      device: this.config ? { marka: this.config.marka, model: this.config.model, ip: this.config.ip, port: this.config.port, connectionType: this.config.connection_type } : null,
      connected: this.state.connected,
      lastError: this.state.lastError,
      checkedAt: this.state.checkedAt,
      capabilities: { sale: !!caps.sale, reports: !!caps.reports, pending: !!caps.pending },
      busy: this.busy,
      pendingCount: this.journal.filter(j => !j.acked && j.status !== 'declined' && j.status !== 'cancelled').length,
    };
  }

  async connect() {
    if (!this.driver) return { ok: false, error: 'POS cihazı tanımlı değil. Panel → POS Ayarları\'ndan cihaz ve sürücü seçin.' };
    try {
      await this.driver.ping();
      this.state = { connected: true, lastError: null, checkedAt: Date.now() };
      return { ok: true, status: this.status() };
    } catch (e) {
      this.state = { connected: false, lastError: e.message, checkedAt: Date.now() };
      return { ok: false, error: e.message, status: this.status() };
    }
  }
  _startHealth() { this._stopHealth(); this.timer = setInterval(() => { if (!this.busy) this.connect().catch(() => {}); }, this.healthMs); if (this.timer.unref) this.timer.unref(); }
  _stopHealth() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  close() { this._stopHealth(); if (this.driver && this.driver.close) this.driver.close(); }

  // ---- Satış ----
  // req: { txnId, orderId, amount, payType: 'card'|'cash'|'meal', label, items:[{name,qty,unitPrice,vat}], cashier }
  async sale(req) {
    if (!this.driver) return { ok: false, status: 'error', message: 'POS cihazı tanımlı değil.' };
    if (!this.driver.capabilities.sale) return { ok: false, status: 'unsupported', message: `${DRIVER_LABELS[this.config.driver]} ile satış henüz desteklenmiyor.` };
    const r = req || {};
    const amount = round2(r.amount);
    if (!r.txnId || !(amount > 0)) return { ok: false, status: 'error', message: 'Geçersiz ödeme isteği.' };
    if (this.busy) return { ok: false, status: 'busy', message: 'Cihaz başka bir işlemle meşgul.' };
    const prev = this._entry(r.txnId);
    if (prev && ['approved', 'declined', 'cancelled'].includes(prev.status)) return { ok: prev.status === 'approved', ...prev.result, txnId: r.txnId, status: prev.status, repeated: true };
    this.busy = true;
    const entry = prev || { txnId: r.txnId, orderId: r.orderId || null, amount, payType: r.payType || 'card', label: r.label || '', createdAt: Date.now(), status: 'sending', acked: false };
    if (!prev) this.journal.push(entry);
    entry.status = 'sending';
    this._saveJournal(); // cihaza gitmeden ÖNCE kayıt
    try {
      const res = await this.driver.sale({ ...r, amount });
      entry.status = res.status; entry.result = res; entry.finishedAt = Date.now();
      this._saveJournal();
      this.state.connected = true; this.state.lastError = null;
      return { ok: res.status === 'approved', txnId: r.txnId, ...res };
    } catch (e) {
      // Bağlantı işlem ortasında koptu: sonuç bilinmiyor → askıda
      entry.status = 'unknown'; entry.error = e.message; this._saveJournal();
      this.state.connected = false; this.state.lastError = e.message;
      return { ok: false, txnId: r.txnId, status: 'unknown', message: 'Cihazla bağlantı koptu, ödemenin sonucu bilinmiyor. "Askıda Ödeme Kontrolü" ile kontrol edin. Müşteriden ikinci kez ödeme almayın.' };
    } finally { this.busy = false; }
  }

  // Askıda ödemeler: sonucu bilinmeyenleri cihaza sorar; kasaya iletilmemiş
  // (ack edilmemiş) onaylı ödemeleri listeler.
  async pending() {
    if (this.driver && this.driver.capabilities.pending) {
      for (const j of this.journal.filter(x => !x.acked && (x.status === 'unknown' || x.status === 'sending'))) {
        try {
          const res = await this.driver.checkTransaction(j);
          if (res && res.status && res.status !== 'unknown') { j.status = res.status; j.result = res; j.finishedAt = Date.now(); }
        } catch (e) { /* cihaz yoksa sonra tekrar */ }
      }
      this._saveJournal();
    }
    return this.journal.filter(j => !j.acked && j.status !== 'declined' && j.status !== 'cancelled')
      .map(j => ({ txnId: j.txnId, orderId: j.orderId, amount: j.amount, payType: j.payType, label: j.label, status: j.status, createdAt: j.createdAt, result: j.result || null }));
  }

  // Kasa ödemeyi DurakPOS'a yazdı (ya da vazgeçildi) → askıdan çıkar
  ack(txnId) {
    const j = this._entry(txnId);
    if (!j) return { ok: false, error: 'İşlem bulunamadı' };
    j.acked = true; j.ackedAt = Date.now(); this._saveJournal();
    return { ok: true };
  }

  // Z / X raporu, banka gün sonu, son fiş kopyası
  async report(kind) {
    const KINDS = { z: 'Z raporu', x: 'X raporu', bank_eod: 'Banka gün sonu', last_receipt: 'Son fiş kopyası' };
    if (!KINDS[kind]) return { ok: false, error: 'Bilinmeyen işlem' };
    if (!this.driver) return { ok: false, error: 'POS cihazı tanımlı değil.' };
    if (!this.driver.capabilities.reports) return { ok: false, error: `${KINDS[kind]}: ${DRIVER_LABELS[this.config.driver]} ile henüz desteklenmiyor.` };
    if (this.busy) return { ok: false, error: 'Cihaz başka bir işlemle meşgul.' };
    this.busy = true;
    try { const r = await this.driver.report(kind); return { ok: true, kind, label: KINDS[kind], ...r }; }
    catch (e) { return { ok: false, error: `${KINDS[kind]} alınamadı: ${e.message}` }; }
    finally { this.busy = false; }
  }
}

module.exports = { PosBridge, DRIVER_LABELS };
