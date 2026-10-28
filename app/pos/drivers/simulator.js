// Deneme cihazı: gerçek POS olmadan tüm akışı denemek için.
//   - Tutarın kuruşu ,13 ise: kart reddedilir
//   - Tutarın kuruşu ,66 ise: onaylanır ama bağlantı "kopar" (askıda ödeme denemesi)
//   - Tutarın kuruşu ,77 ise: müşteri cihazda vazgeçer
let receiptNo = 1000, zNo = 42;
function createSimulator(config) {
  const approved = new Map(); // txnId → sonuç (cihazın kendi hafızası)
  const delay = Number(config.simDelayMs ?? 1200);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  return {
    capabilities: { sale: true, reports: true, pending: true },
    async ping() { await wait(50); return true; },
    async sale(req) {
      await wait(delay);
      const cents = Math.round((req.amount % 1) * 100);
      if (cents === 13) return { status: 'declined', message: 'Kart reddedildi (deneme)' };
      if (cents === 77) return { status: 'cancelled', message: 'Müşteri cihazda vazgeçti (deneme)' };
      const res = { status: 'approved', receiptNo: ++receiptNo, zNo, authCode: String(100000 + Math.floor(Math.random() * 899999)), cardMasked: req.payType === 'card' ? '4543 **** **** 1234' : null, device: 'SIMULATOR' };
      approved.set(req.txnId, res);
      if (cents === 66) throw new Error('Bağlantı koptu (deneme)');
      return res;
    },
    async checkTransaction(j) { await wait(100); return approved.get(j.txnId) || { status: 'declined', message: 'Cihazda bu işlem yok' }; },
    async report(kind) { await wait(600); if (kind === 'z') zNo++; return { message: `${{ z: 'Z raporu', x: 'X raporu', bank_eod: 'Banka gün sonu', last_receipt: 'Son fiş kopyası' }[kind]} cihazdan basıldı (deneme)`, zNo }; },
    close() {},
  };
}
module.exports = { createSimulator };
