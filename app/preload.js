const { contextBridge, ipcRenderer } = require('electron');

// Kasa sayfası (web içeriği) bu fonksiyonları çağırarak, tarayıcının yazdırma
// penceresini hiç açmadan doğrudan yazıcıya fiş bastırabilir. Sayfa bu
// nesnenin varlığını kontrol ederek "masaüstü programında mıyım, yoksa
// normal tarayıcıda mıyım" ayrımını da yapıyor.
//
// 1.0.19 ile gelenler (panel → Cihazlar ve Yazıcılar):
//   • silentPrint(html, { deviceName, paperMm }) — belirli bir yazıcıdan bas
//   • getPrinters()   — bu bilgisayardaki yazıcı listesi
//   • printNetwork({ ip, port, text }) — ağ termal yazıcısına doğrudan (ESC/POS)
//   • version         — program sürümü
let version = null;
try { version = ipcRenderer.sendSync('app-version'); } catch (e) {}

contextBridge.exposeInMainWorld('durakPOS', {
  version,
  silentPrint: (htmlContent, opts) => ipcRenderer.invoke('silent-print', htmlContent, opts || {}),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  printNetwork: (job) => ipcRenderer.invoke('print-network', job || {}),
  openCustomerDisplay: (tenantSlug) => ipcRenderer.invoke('open-customer-display', tenantSlug),
  openCashDrawer: () => ipcRenderer.invoke('open-cash-drawer'),
  // 1.0.21: yazarkasa POS köprüsü (Ingenico GMP-3 / deneme cihazı)
  pos: {
    configure: (cfg) => ipcRenderer.invoke('pos', 'configure', cfg || {}),
    status: () => ipcRenderer.invoke('pos', 'status'),
    connect: () => ipcRenderer.invoke('pos', 'connect'),
    sale: (req) => ipcRenderer.invoke('pos', 'sale', req || {}),
    pending: () => ipcRenderer.invoke('pos', 'pending'),
    ack: (txnId) => ipcRenderer.invoke('pos', 'ack', txnId),
    report: (kind) => ipcRenderer.invoke('pos', 'report', kind),
  },
});
