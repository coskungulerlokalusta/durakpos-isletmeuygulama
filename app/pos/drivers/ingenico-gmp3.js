// Ingenico (Move/5000F vb.) — GMP-3 protokolü.
//
// GMP-3 ile satış/rapor komutları için Ingenico'nun entegrasyon dokümanı ve
// eşleşme (pairing) kodları gerekiyor (iKasa / Ingenico çözüm ortağı). Onlar
// gelene kadar bu sürücü:
//   - cihazın ağda erişilebilir olduğunu (IP:port) kontrol eder → "POS bağlı"
//   - satış/rapor desteklemez → kasa normal (elle) ödeme akışında kalır
// Kodlar gelince sadece sale/report/checkTransaction doldurulup
// capabilities açılır; kasa ve Panel tarafında başka değişiklik gerekmez.
const net = require('net');
function createIngenicoGmp3(config) {
  const ip = String(config.ip || '').trim();
  const port = Number(config.port) || 7500;
  return {
    capabilities: { sale: false, reports: false, pending: false },
    ping() {
      return new Promise((resolve, reject) => {
        if (String(config.connection_type || 'ethernet') !== 'ethernet') return reject(new Error('Kablo (seri port) bağlantısı GMP-3 kodlarıyla birlikte eklenecek; şimdilik Ethernet seçin.'));
        if (!/^[0-9a-zA-Z.\-]+$/.test(ip)) return reject(new Error('Cihaz IP adresi girilmemiş.'));
        const s = new net.Socket(); let done = false;
        const fin = (err) => { if (done) return; done = true; try { s.destroy(); } catch (e) {} err ? reject(err) : resolve(true); };
        s.setTimeout(4000, () => fin(new Error(`Cihaza ulaşılamadı (${ip}:${port}) — cihaz açık ve aynı ağda mı?`)));
        s.on('error', e => fin(new Error(`Cihaza ulaşılamadı (${ip}:${port}): ${e.code || e.message}`)));
        s.connect(port, ip, () => fin(null));
      });
    },
    async sale() { throw new Error('GMP-3 entegrasyon kodları henüz yüklenmedi.'); },
    async checkTransaction() { return { status: 'unknown' }; },
    async report() { throw new Error('GMP-3 entegrasyon kodları henüz yüklenmedi.'); },
    close() {},
  };
}
module.exports = { createIngenicoGmp3 };
