const { app, BrowserWindow, Menu, ipcMain, screen, shell } = require('electron');
const net = require('net');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// HTTP/3 (QUIC) KAPALI: Cloudflare/LiteSpeed "HTTP/3 ile bağlan" diyor; bu
// bağlantıda kasa sayfasının indirmesi yarıda takılıyor (teşhis satırı
// "html=0ms/0KB/h3", ekran "Sunucuya bağlanılıyor"da kalıyor). Sunucudaki
// "Alt-Svc: clear" Cloudflare arkasında her zaman yetmiyor — programın
// kendisinde kapatıyoruz, bağlantılar normal TCP (HTTP/2) ile kurulur.
app.commandLine.appendSwitch('disable-quic');

// Tarayıcı menüsünü (Dosya/Düzen/Görünüm gibi) tamamen kaldırıyoruz —
// gerçek bir program gibi görünsün, tarayıcı gibi değil.
Menu.setApplicationMenu(null);

// Otomatik güncelleme — SATICI HİÇBİR ŞEY YAPMADAN, kendi kendine
// çalışması gerekiyor (yüzlerce müşteriye elle "şunu indirin" diyemeyiz).
// Önceki tasarım sadece PROGRAM AÇILIRKEN bir kez kontrol ediyordu ve
// güncellemeyi sadece "program elle kapatılırsa" kuruyordu — kasa
// programları genelde gün boyu HİÇ kapatılmadığı için bu güncellemenin
// günlerce hiç uygulanmamasına sebep olabiliyordu. Şimdi:
// 1) Periyodik olarak (30 dakikada bir) tekrar kontrol ediyor,
// 2) İndirme bitince, sepetin boş olduğu ilk uygun anı bekleyip
//    KENDİLİĞİNDEN yeniden başlatıp kuruyor — kasiyerin hiçbir şey
//    yapmasına gerek kalmadan.
autoUpdater.autoDownload = true;
let updateReadyToInstall = false;
let installAttemptTimer = null;
autoUpdater.on('update-downloaded', () => {
  updateReadyToInstall = true;
  scheduleInstallWhenIdle();
});
function scheduleInstallWhenIdle() {
  if (installAttemptTimer) return; // zaten deneniyor
  installAttemptTimer = setInterval(async () => {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    if (!win) { autoUpdater.quitAndInstall(); return; } // kimse kullanmıyor, hemen kur
    try {
      // Kasa sayfasına "sepette ürün var mı" diye soruyoruz — doluysa
      // kasiyerin işini bölmemek için bu turu atlıyoruz, bir dakika sonra
      // tekrar deneyeceğiz.
      const cartEmpty = await win.webContents.executeJavaScript('typeof cart === "undefined" || cart.length === 0').catch(() => true);
      if (cartEmpty) { clearInterval(installAttemptTimer); autoUpdater.quitAndInstall(); }
    } catch (e) { /* bir sonraki turda tekrar denenecek */ }
  }, 60 * 1000); // her 1 dakikada bir uygun an var mı diye bakıyor
}

const REMOTE_ORIGIN = 'https://durakpos.com';
const REMOTE_URL = REMOTE_ORIGIN + '/kasa';
const LOCAL_FALLBACK = path.join(__dirname, 'DurakPOS.html');

// Sunucu şu an cevap veriyor mu? Sayfayı yeniden yüklemeden ÖNCE soruyoruz:
// internet/sunucu yokken loadURL çağrılırsa, açık olan (çalışan) kasa
// sayfası gidip yerine BEYAZ bir hata sayfası geliyordu — kasiyer programı
// kapatıp açana kadar kasa kullanılamıyordu.
function serverReachable() {
  return new Promise(resolve => {
    const req = https.get(REMOTE_ORIGIN + '/api/health', { timeout: 5000 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// Masaüstü köprüsünü (yazıcı, ağ yazıcısı, müşteri ekranı) sadece kendi
// kasa sayfamız kullanabilsin — pencere bir şekilde başka bir siteye
// giderse, o site bilgisayarın yerel ağına bağlantı açamasın.
function isTrustedSender(event) {
  const url = (event.senderFrame && event.senderFrame.url) || '';
  return url.startsWith(REMOTE_ORIGIN + '/') || url.startsWith('file://');
}

// İkinci monitör (müşteri ekranı) — kasa programından bağımsız bir pencere.
// Bilgisayarda ikinci bir monitör varsa otomatik olarak orada tam ekran açılır;
// hangi işletmenin ekranını göstereceğini kasa sayfası (renderer) login
// olduktan sonra kendisi bildirir (openCustomerDisplay IPC çağrısıyla).
let displayWin = null;

function findSecondaryDisplay() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return displays.find(d => d.id !== primary.id) || null;
}

function ensureDisplayWindow() {
  const secondary = findSecondaryDisplay();
  if (!secondary) return null; // tek monitör varsa hiçbir şey açmıyoruz
  if (displayWin && !displayWin.isDestroyed()) return displayWin;

  displayWin = new BrowserWindow({
    x: secondary.bounds.x,
    y: secondary.bounds.y,
    width: secondary.bounds.width,
    height: secondary.bounds.height,
    frame: false,
    resizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // NOT: setFullScreen(true) kullanmıyoruz — farklı DPI/ölçeklendirme
  // ayarlarına sahip iki monitörde Windows'un tam ekran geçişi pencereyi
  // yanlış boyuta getirip görüntünün ekran dışına taşmasına sebep olabiliyor.
  // Zaten x/y/width/height ile ikinci monitörün TAM sınırlarını verdiğimiz
  // ve çerçevesiz (frame:false) olduğu için görsel olarak tam ekran gibi
  // görünüyor, ekstra bir "fullscreen" moduna hiç girmeden.
  displayWin.once('ready-to-show', () => {
    displayWin.setBounds(secondary.bounds); // garanti olsun diye tekrar
    displayWin.showInactive(); // kasa penceresinin klavye odağını çalmasın
  });
  displayWin.on('closed', () => { displayWin = null; });
  return displayWin;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'DurakPOS — Kasa',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#F7F4EE',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Önce buluttan en güncel sürümü yüklemeyi dene — böylece kasa kodunu
  // güncellediğimizde programı yeniden indirmenize gerek kalmaz.
  // İnternet yoksa, programın içine gömülü son bilinen sürümü açar (çevrimdışı çalışmaya devam eder).
  let fallenBack = false;
  // ÖNEMLİ: kasa.html'in kendi içinde zaten menü/sipariş verisini
  // localStorage'a yedekleyen bir çevrimdışı sistemi var — AMA bu veri,
  // "https://durakpos.com" adresine ait. Yerel yedek dosyaya (file://
  // üzerinden) geçersek, bu TAMAMEN FARKLI bir "adres" sayıldığı için o
  // önbelleğe hiç erişemiyor — program sıfırdan, boş açılıyor. Bu yüzden
  // yerel yedeğe SADECE program hiç başarıyla açılmamışsa (ilk kurulumda,
  // internet yokken ilk kez açılıyorsa) geçiyoruz. Daha önce en az bir kez
  // başarıyla açıldıysa, sonraki bir yenileme denemesi internetsizlikten
  // başarısız olursa, MEVCUT (doğru adresteki, önbelleği olan) sayfayı
  // olduğu gibi bırakıyoruz — üzerine yazmıyoruz.
  let hasEverLoadedSuccessfully = false;
  function fallbackToLocal() {
    if (fallenBack || hasEverLoadedSuccessfully) return;
    fallenBack = true;
    win.loadFile(LOCAL_FALLBACK);
  }
  // ÖNEMLİ: sadece Electron'un kendi önbelleğini temizlemek (clearCache)
  // yeterli değil — Cloudflare gibi ARADA duran bir sunucu da eski bir
  // kopyayı önbellekte tutuyor olabilir. Bunu kesin olarak aşmak için,
  // adrese HER SEFERİNDE FARKLI bir sorgu parametresi (?_=zaman damgası)
  // ekliyoruz — bu, "bu tamamen yeni bir istek, önbellekteki eski kopyayı
  // ASLA kullanma" demenin en kesin yolu, hem tarayıcı hem CDN seviyesinde.
  function freshRemoteUrl() {
    return `${REMOTE_URL}?_=${Date.now()}`;
  }
  let lastLoadTime = 0;
  let reloadCheckRunning = false;
  async function loadFreshRemote() {
    // Sayfa bir kez açıldıysa, sunucuya ulaşılamıyorken yeniden yükleme —
    // mevcut (çalışan, çevrimdışı önbelleği olan) sayfa olduğu gibi kalsın.
    if (hasEverLoadedSuccessfully) {
      if (reloadCheckRunning) return;
      reloadCheckRunning = true;
      const ok = await serverReachable();
      reloadCheckRunning = false;
      if (!ok) return;
    }
    lastLoadTime = Date.now();
    win.webContents.session.clearCache().finally(() => {
      win.loadURL(freshRemoteUrl()).then(() => { hasEverLoadedSuccessfully = true; }).catch(fallbackToLocal);
    });
  }
  // Kasa sayfası dışında bir yere gidilmesin; dış bağlantılar (ör. WhatsApp)
  // programın içinde değil, bilgisayarın tarayıcısında açılsın. Fiş/rapor
  // önizlemesi için açılan boş pencerelere (window.open('')) izin veriliyor.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(REMOTE_ORIGIN + '/') || url.startsWith('file://')) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank' || url.startsWith(REMOTE_ORIGIN + '/')) return { action: 'allow' };
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  loadFreshRemote();
  // ÖNEMLİ: kasiyer programı gün boyu hiç kapatmayabilir (sadece küçültür).
  // Önceden sadece PROGRAM AÇILIRKEN taze kopya çekiliyordu — pencere gün
  // boyu açık kaldığı sürece güncellemeler hiç yansımıyordu. Artık pencere
  // her ön plana geldiğinde (kasiyer tekrar tıkladığında) de taze bir kopya
  // çekiliyor — kasiyerin elle bir şey yapmasına gerek kalmadan.
  // DİKKAT: Electron, pencere AÇILIRKEN de bir "focus" olayı ateşleyebiliyor
  // — bu, henüz ilk yükleme bitmeden sayfayı ikinci kez başlatıp, ürün
  // listesini çeken kodu yarıda kesiyordu ("ürün bulunamadı" hatasının asıl
  // sebebi buydu). Son yüklemeden bu yana en az 5 saniye geçmediyse,
  // "focus" olayını görmezden geliyoruz.
  // DİKKAT: Bu değer önceden 5 saniyeydi — bu, kasiyer sadece BAŞKA BİR
  // PENCEREYE geçip kasa penceresine geri dönse bile sayfanın tamamen
  // yeniden yüklenmesine (ve oturumun/sepetin bozulmasına, "kendiliğinden
  // çıkış" hissi vermesine) sebep oluyordu. Artık en az 20 DAKİKA geçmeden
  // pencere odaklanma olayında yeniden yükleme yapılmıyor — zaten periyodik
  // kontrol (30 dakikada bir) ve program açılışı ayrıca güncel tutuyor.
  //
  // İKİNCİ BİR İNCE HATA: sayfa içindeki confirm()/alert() gibi native
  // tarayıcı pencereleri (örn. "Bu siparişi silmek istiyor musunuz?") açılıp
  // kapanırken, Electron penceresi ANLIK olarak odağını kaybedip hemen geri
  // kazanıyor — bu da "focus" olayını tetikleyip (20 dakika kuralına takılsa
  // bile, uzun süre açık kalan kasalarda) yanlışlıkla sayfayı sıfırlıyor,
  // "sil'e bastım, çıkış yaptı" hissi veriyordu. Bunu da engellemek için,
  // odaklanmadan HEMEN önce bir "blur" (odak kaybı) olmuşsa ve bu çok
  // yakın zamanda (3 saniyeden az önce) olduysa, bunu native bir diyalog
  // kapanışı sayıp yeniden yüklemeyi atlıyoruz.
  let lastBlurTime = 0;
  win.on('blur', () => { lastBlurTime = Date.now(); });
  win.on('focus', () => {
    // Windows'ta pencere odağı geri geldiğinde klavye sayfaya verilmeyebiliyor
    // (yazı kutusuna tıklanıyor ama yazılmıyor) — sayfaya açıkça odak ver.
    try { win.webContents.focus(); } catch (e) {}
    const justClosedNativeDialog = lastBlurTime && (Date.now() - lastBlurTime < 3000);
    if (justClosedNativeDialog) return;
    if (!fallenBack && Date.now() - lastLoadTime > 20 * 60 * 1000) loadFreshRemote();
  });
  // ÖNEMLİ: sadece ana sayfanın kendisi yüklenemezse yedeğe düş — küçük bir
  // alt kaynağın (ikon, font, favicon vb.) başarısız olması yedeğe düşmemeli,
  // yoksa site güncel olsa bile programa hep eski gömülü kopya açılır.
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 (ERR_ABORTED): yükleme, yerine yenisi başladığı için iptal edildi —
    // gerçek bir hata değil, yedeğe düşmemeli.
    if (errorCode === -3) return;
    if (hasEverLoadedSuccessfully) {
      // Daha önce açılmıştı ama bu yükleme başarısız oldu (beyaz ekran) —
      // sunucu/internet gelince kendiliğinden tekrar dene.
      setTimeout(loadFreshRemote, 15 * 1000);
      return;
    }
    fallbackToLocal();
  });

  // Geliştirici paneli (F12/Ctrl+Shift+I) ve tam ekran (F11) — tek dinleyicide
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toUpperCase() === 'I')) {
      win.webContents.toggleDevTools();
    }
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
    }
  });

  // Ana kasa penceresi kapanınca, açık olan müşteri ekranını da kapat —
  // yalnız kalıp ekranda takılı kalmasın.
  win.on('closed', () => {
    if (displayWin && !displayWin.isDestroyed()) displayWin.close();
  });
}

app.whenReady().then(() => {
  createWindow();
  // Açılışta bir kez, sonra her 30 dakikada bir tekrar güncelleme kontrolü
  // yap — hata olursa (internet yok vb.) sessizce geç, programın açılmasını
  // hiçbir şekilde engellemesin.
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 30 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Kasa sayfasından gelen "sessiz yazdır" isteğini karşılar — görünmez bir
// pencerede fiş HTML'ini yükleyip, hiçbir onay/önizleme penceresi açmadan
// yazıcıya gönderir.
// 1.0.19: opts.deviceName verilirse O yazıcıdan basar (Bar / Mutfak / Kasa
// yazıcıları ayrı ayrı) — verilmezse eskisi gibi Windows varsayılan yazıcısı.
// opts.paperMm: 80 (varsayılan) ya da 58.
ipcMain.handle('silent-print', async (event, htmlContent, opts = {}) => {
  if (!isTrustedSender(event)) return { ok: false, error: 'Yetkisiz istek' };
  const printWin = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  try {
    await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent));
    const widthMicron = Number(opts && opts.paperMm) === 58 ? 58000 : 80000;
    // ÖNEMLİ: Electron'un print() geri çağrısı, yazıcı donanımı/sürücü/kağıt
    // sorunu gibi durumlarda HİÇ tetiklenmeyebiliyor — bu da ödeme ekranının
    // "yükleniyor" durumunda sonsuza kadar takılı kalmasına sebep oluyordu.
    // 8 saniyelik bir zaman aşımı ekleyerek, yazıcı cevap vermese bile
    // kasiyerin satışa devam edebilmesini garanti ediyoruz.
    await Promise.race([
      new Promise((resolve, reject) => {
        // pageSize'ı mikron cinsinden açıkça veriyoruz — belirtilmezse
        // Windows'un varsayılan (A4 gibi geniş) sayfa boyutunu kullanabiliyor,
        // bu da fişin sağ kenarının kırpılmasına/kaymasına sebep oluyordu.
        const printOpts = {
          silent: true,
          printBackground: true,
          pageSize: { width: widthMicron, height: 297000 },
          margins: { marginType: 'none' },
        };
        if (opts && opts.deviceName) printOpts.deviceName = String(opts.deviceName);
        printWin.webContents.print(printOpts, (success, errorType) => {
          if (success) resolve(); else reject(new Error(errorType || 'Yazdırma başarısız'));
        });
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Yazıcı zaman aşımına uğradı — yazıcının açık/bağlı olduğundan emin olun')), 8000)),
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    printWin.close();
    // Görünmez yazdırma penceresi kapanınca klavye ana pencereye dönsün
    const main = BrowserWindow.fromWebContents(event.sender);
    if (main && !main.isDestroyed() && main.isFocused()) { try { main.webContents.focus(); } catch (e) {} }
  }
});

// Bu bilgisayardaki yazıcılar — panelde "Cihazlar ve Yazıcılar"da her
// istasyon için (Bar/Mutfak/Kasa) buradan yazıcı seçiliyor.
ipcMain.handle('get-printers', async (event) => {
  if (!isTrustedSender(event)) return [];
  try {
    const list = await event.sender.getPrintersAsync();
    return list.map(p => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
  } catch (e) {
    return [];
  }
});

// Sayfa, program sürümünü eşzamanlı okuyabilsin (window.durakPOS.version)
ipcMain.on('app-version', (event) => { event.returnValue = app.getVersion(); });

// ---- Ağ (Ethernet/Wi-Fi) termal yazıcı — IP:9100 üzerinden doğrudan ESC/POS ----
// Windows'a sürücü kurmaya gerek kalmadan, mutfaktaki ağ yazıcısına düz
// metin fiş basar. Türkçe karakterler için PC857 (Türkçe) kod sayfası.
const CP857 = { 'Ç':0x80,'ü':0x81,'é':0x82,'â':0x83,'ä':0x84,'à':0x85,'ç':0x87,'ê':0x88,'ë':0x89,'è':0x8A,'ï':0x8B,'î':0x8C,'ı':0x8D,'Ä':0x8E,'É':0x90,
  'ô':0x93,'ö':0x94,'ò':0x95,'û':0x96,'ù':0x97,'İ':0x98,'Ö':0x99,'Ü':0x9A,'Ş':0x9E,'ş':0x9F,'á':0xA0,'í':0xA1,'ó':0xA2,'ú':0xA3,'ñ':0xA4,'Ñ':0xA5,'Ğ':0xA6,'ğ':0xA7 };
function encodeCp857(str) {
  const out = [];
  for (const ch of String(str).replace(/₺/g, 'TL')) {
    const c = ch.charCodeAt(0);
    if (c < 0x80) out.push(c);
    else if (CP857[ch] != null) out.push(CP857[ch]);
    else out.push(0x3F); // '?'
  }
  return Buffer.from(out);
}
function escposTicket(text, cut) {
  const ESC = 0x1B, GS = 0x1D;
  const parts = [Buffer.from([ESC, 0x40]), Buffer.from([ESC, 0x74, 13])]; // başlat + PC857
  String(text || '').split('\n').forEach((line, i) => {
    const big = i === 0;                                // başlık (MUTFAK / BAR)
    const item = /^\s*-?\d+ x /.test(line);             // ürün satırı
    parts.push(Buffer.from([GS, 0x21, big ? 0x11 : item ? 0x01 : 0x00])); // boyut
    parts.push(Buffer.from([ESC, 0x45, (big || item) ? 1 : 0]));         // kalın
    parts.push(encodeCp857(line), Buffer.from([0x0A]));
  });
  parts.push(Buffer.from([GS, 0x21, 0x00, ESC, 0x45, 0, 0x0A, 0x0A, 0x0A, 0x0A]));
  if (cut !== false) parts.push(Buffer.from([GS, 0x56, 0x42, 0x00])); // kağıdı kes
  return Buffer.concat(parts);
}
ipcMain.handle('print-network', async (event, job = {}) => {
  if (!isTrustedSender(event)) return { ok: false, error: 'Yetkisiz istek' };
  const ip = String(job.ip || '').trim();
  const port = Number(job.port) || 9100;
  if (!/^[0-9a-zA-Z.\-]+$/.test(ip)) return { ok: false, error: 'Yazıcı IP adresi geçersiz' };
  const data = escposTicket(job.text, job.cut);
  return await new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} resolve(r); };
    sock.setTimeout(6000, () => finish({ ok: false, error: `Yazıcıya ulaşılamadı (${ip}:${port}) — açık ve ağa bağlı mı?` }));
    sock.on('error', (e) => finish({ ok: false, error: `Yazıcı hatası (${ip}:${port}): ${e.code || e.message}` }));
    sock.connect(port, ip, () => { sock.write(data, () => { sock.end(); setTimeout(() => finish({ ok: true }), 150); }); });
  });
});

// Kasa çekmecesini otomatik açma özelliği — bunun için gereken "printer"
// paketi çok eski bir native (C++) modül olduğu için, kurulum bilgisayarında
// Visual Studio derleme araçları + yeterli disk alanı gerektiriyordu. Bu,
// kurulum sürecini çok zorlaştırdığı için ŞİMDİLİK devre dışı bırakıldı —
// çekmece elle (tırnak/anahtarla) açılmaya devam ediyor. İleride, daha
// hafif/modern bir kütüphaneyle (veya bilgisayarda derleme araçları hazır
// olduğunda) tekrar eklenebilir.
ipcMain.handle('open-cash-drawer', async () => {
  return { ok: false, error: 'Bu özellik şu an aktif değil — çekmeceyi elle açabilirsiniz.' };
});

// Kasa sayfası, kullanıcı giriş yaptığında hangi işletmenin (slug) müşteri
// ekranını göstereceğimizi bu çağrıyla bildirir. İkinci monitör varsa orada
// otomatik açılır; tek monitörlü bilgisayarlarda hiçbir şey olmaz.
ipcMain.handle('open-customer-display', async (event, tenantSlug) => {
  if (!isTrustedSender(event)) return { ok: false, error: 'Yetkisiz istek' };
  const win = ensureDisplayWindow();
  if (!win) return { ok: false, reason: 'no-secondary-display' };
  try {
    await win.loadURL(`${REMOTE_ORIGIN}/ekran/${encodeURIComponent(String(tenantSlug || ''))}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.on('window-all-closed', () => {
  // Kapatılırken bekleyen bir güncelleme varsa, yeniden açmadan önce onu
  // kur — böylece bir sonraki açılışta zaten en güncel sürüm çalışır.
  if (updateReadyToInstall) { autoUpdater.quitAndInstall(); return; }
  if (process.platform !== 'darwin') app.quit();
});
