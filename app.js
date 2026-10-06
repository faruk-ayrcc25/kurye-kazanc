/* =========================================================
   Kurye Kazanç Takip — uygulama mantığı
   ---------------------------------------------------------
   - Framework yok, sade JavaScript.
   - Veriler telefonda IndexedDB içinde saklanır (sunucu yok).
   - Üç tablo (object store) var:
       packages : { id, day, time, amount, note, createdAt }
       expenses : { id, day, time, category, amount, note, createdAt }
       settings : { key, value }
     "day" alanı İŞ GÜNÜDÜR (YYYY-AA-GG). Gün başlangıç saatinden
     önce (örn. 05:00) girilen kayıtlar önceki iş gününe yazılır.
   ========================================================= */
'use strict';

/* ---------------------------------------------------------
   1) SABİTLER VE DURUM
   --------------------------------------------------------- */
const DB_NAME = 'kurye-kazanc';
const DB_VERSION = 1;
const DEFAULT_CATEGORIES = ['Yakıt', 'Sigara', 'Yemek', 'Motor bakım/tamir', 'Telefon/İnternet', 'Diğer'];
const DEFAULT_SETTINGS = { dayStart: '05:00', theme: 'dark', customCategories: [], lastCategory: 'Yakıt' };

// Uygulamanın anlık durumu
const state = {
  tab: 'today',          // açık sekme: today | summary | settings
  day: null,             // Bugün ekranında gösterilen iş günü (YYYY-AA-GG)
  today: null,           // gerçek "bugün" (iş günü hesabıyla)
  summaryMode: 'month',  // week | month | year
  month: null,           // özet ekranındaki ay (YYYY-AA)
  week: null,            // özet ekranındaki haftanın pazartesisi (YYYY-AA-GG)
  year: null,            // özet ekranındaki yıl (sayı)
  settings: { ...DEFAULT_SETTINGS },
  quickAmounts: [],      // hızlı seçim tutarları
  editing: null,         // düzenlenen kayıt (yoksa null = yeni kayıt)
  exCategory: null,      // gider formunda seçili kategori
};

let db = null; // IndexedDB bağlantısı

/* ---------------------------------------------------------
   2) BİÇİMLENDİRME YARDIMCILARI (tr-TR)
   --------------------------------------------------------- */
const moneyFmt = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const longDateFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
const shortDateFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', weekday: 'short' });
const monthFmt = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' });
const monthShortFmt = new Intl.DateTimeFormat('tr-TR', { month: 'short' });

/** Kuruş hatalarını önlemek için 2 basamağa yuvarlar */
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
/** 1250.5 → "1.250,5 ₺" */
const money = n => moneyFmt.format(round2(n)) + ' ₺';
/** Tablolar için ₺ işaretsiz tutar (dar ekrana sığsın): 2220.5 → "2.220,5" */
const plain = n => moneyFmt.format(round2(n));
/** Kullanıcının yazdığı tutarı sayıya çevirir: "1.250,50" / "250" / "12,5" */
function parseAmount(str) {
  let s = String(str || '').trim().replace(/\s|₺/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // Türkçe biçim
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');  // "1.250" binlik ayraç
  const n = Number(s);
  return Number.isFinite(n) ? round2(n) : NaN;
}
/** HTML'e güvenli yazı basmak için (notlarda < > vb. olabilir) */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Tarih yardımcıları ----------
   Tarihler "YYYY-AA-GG" metni olarak tutulur; böylece sıralama ve
   IndexedDB aralık sorguları basit metin karşılaştırmasıyla çalışır. */
const pad = n => String(n).padStart(2, '0');
const dateToKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Öğlen 12:00 kullanılır ki saat dilimi/yaz saati kaymaları günü değiştirmesin */
function keyToDate(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); }
function addDays(k, n) { const d = keyToDate(k); d.setDate(d.getDate() + n); return dateToKey(d); }
const timeToMin = t => { const [h, m] = String(t || '00:00').split(':').map(Number); return h * 60 + m; };
const nowTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtLong = k => longDateFmt.format(keyToDate(k));
const fmtShort = k => shortDateFmt.format(keyToDate(k));
const fmtMonth = m => cap(monthFmt.format(keyToDate(m + '-01')));
const cap = s => s.charAt(0).toLocaleUpperCase('tr-TR') + s.slice(1);
const daysInMonth = m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0).getDate(); };
function addMonths(m, n) { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + n, 1, 12); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
/** Verilen günün haftasının pazartesisi */
function weekStartOf(k) { const d = keyToDate(k); return addDays(k, -((d.getDay() + 6) % 7)); }

/** Şu anki saate göre İŞ GÜNÜ: gün başlangıç saatinden önceyse dün sayılır */
function workDayOf(date = new Date()) {
  const k = dateToKey(date);
  const mins = date.getHours() * 60 + date.getMinutes();
  return mins < timeToMin(state.settings.dayStart) ? addDays(k, -1) : k;
}

/** Bir iş günü içindeki kayıtları sıralar: gün başlangıcından itibaren geçen süreye göre.
    (05:00 başlangıçta 23:50 → 01:30 sırası doğru çıkar) */
function cmpRecords(a, b) {
  const s = timeToMin(state.settings.dayStart);
  const oa = (timeToMin(a.time) - s + 1440) % 1440;
  const ob = (timeToMin(b.time) - s + 1440) % 1440;
  return oa - ob || a.createdAt - b.createdAt;
}

/* ---------------------------------------------------------
   3) INDEXEDDB KATMANI
   --------------------------------------------------------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // İlk açılışta tabloları oluştur
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of ['packages', 'expenses']) {
        if (!d.objectStoreNames.contains(name)) {
          const os = d.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
          os.createIndex('day', 'day'); // güne / tarih aralığına göre hızlı sorgu
        }
      }
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
/** IDB isteğini Promise'e çevirir */
const reqP = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const os = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
/** İşlem (transaction) tamamen bitince çözülen Promise */
const txDone = tx => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

const DB = {
  all: name => reqP(os(name).getAll()),
  get: (name, id) => reqP(os(name).get(id)),
  /** from..to (dahil) arasındaki iş günlerine ait kayıtlar */
  range: (name, from, to) => reqP(os(name).index('day').getAll(IDBKeyRange.bound(from, to))),
  put: (name, obj) => reqP(os(name, 'readwrite').put(obj)),
  del: (name, id) => reqP(os(name, 'readwrite').delete(id)),
  count: name => reqP(os(name).count()),
};

async function loadSettings() {
  const rows = await DB.all('settings');
  for (const r of rows) state.settings[r.key] = r.value;
}
async function saveSetting(key, value) {
  state.settings[key] = value;
  await DB.put('settings', { key, value });
}

/* ---------------------------------------------------------
   4) GENEL ARAYÜZ YARDIMCILARI
   --------------------------------------------------------- */
const $ = id => document.getElementById(id);

/* ----- Toast (kısa bildirim), isteğe bağlı "Geri al" düğmesiyle ----- */
let toastTimer = null;
function toast(msg, actionLabel, action) {
  const box = $('toast'), btn = $('toastAction');
  $('toastMsg').textContent = msg;
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel || '';
  btn.onclick = () => { box.hidden = true; action && action(); };
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, actionLabel ? 5000 : 2500);
}

/* ----- Onay penceresi (Promise döner: true/false) ----- */
let confirmResolve = null;
function confirmDialog(msg, yesLabel = 'Evet') {
  $('confirmMsg').textContent = msg;
  $('confirmYes').textContent = yesLabel;
  $('confirmBox').hidden = false;
  return new Promise(res => { confirmResolve = res; });
}
function closeConfirm(result) {
  $('confirmBox').hidden = true;
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(result); }
}

/* ----- Alt pencereler (sheet) -----
   Android'de "geri" tuşu pencereyi kapatsın diye tarayıcı geçmişine bir adım eklenir. */
let openSheetEl = null;
function openSheet(el) {
  if (openSheetEl) openSheetEl.hidden = true;
  el.hidden = false;
  openSheetEl = el;
  history.pushState({ sheet: true }, '');
}
function hideSheet() {
  if (openSheetEl) openSheetEl.hidden = true;
  openSheetEl = null;
  state.editing = null;
  if (document.activeElement) document.activeElement.blur();
}
function closeSheet() {
  if (!openSheetEl) return;
  hideSheet();
  if (history.state && history.state.sheet) history.back();
}
window.addEventListener('popstate', () => {
  if (!$('confirmBox').hidden) closeConfirm(false);
  hideSheet();
});

/** Dosya indirme (JSON yedeği, CSV) */
function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---------------------------------------------------------
   5) SEKMELER
   --------------------------------------------------------- */
function showTab(tab) {
  state.tab = tab;
  for (const t of ['today', 'summary', 'settings']) $('screen-' + t).hidden = t !== tab;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo(0, 0);
  render();
}
function render() {
  if (state.tab === 'today') return renderToday();
  if (state.tab === 'summary') return renderSummary();
  return renderSettings();
}

/* ---------------------------------------------------------
   6) BUGÜN EKRANI
   --------------------------------------------------------- */
async function renderToday() {
  const day = state.day;
  const [pk, ex] = await Promise.all([DB.range('packages', day, day), DB.range('expenses', day, day)]);
  pk.sort(cmpRecords); ex.sort(cmpRecords);

  // Başlık: "Bugün" / "Dün" / gün adı
  const diff = Math.round((keyToDate(day) - keyToDate(state.today)) / 864e5);
  $('dayLabel').textContent = diff === 0 ? 'Bugün' : diff === -1 ? 'Dün' : diff === 1 ? 'Yarın' : 'Geçmiş gün';
  $('dayDate').textContent = fmtLong(day);
  $('nextDay').disabled = day >= state.today;
  $('backToToday').hidden = day === state.today;
  $('datePicker').value = day;
  $('datePicker').max = state.today;

  // Toplamlar
  const income = round2(pk.reduce((s, p) => s + p.amount, 0));
  const expense = round2(ex.reduce((s, e) => s + e.amount, 0));
  const net = round2(income - expense);
  $('tCount').textContent = pk.length;
  $('tIncome').textContent = money(income);
  $('tExpense').textContent = money(expense);
  $('tNet').textContent = money(net);
  $('tNet').classList.toggle('negative', net < 0);
  $('nextPkNo').textContent = `${pk.length + 1}. paket`;

  // Paket listesi (sıra numarasıyla)
  $('pkList').innerHTML = pk.length ? pk.map((p, i) => `
    <li><button class="rec" data-kind="packages" data-id="${p.id}">
      <span class="rec-main">
        <span class="rec-title">${i + 1}. paket</span>
        <span class="rec-sub">${esc(p.time)}${p.note ? ' · ' + esc(p.note) : ''}</span>
      </span>
      <span class="rec-amount good">${money(p.amount)}</span>
    </button></li>`).join('')
    : '<li class="empty">Henüz paket yok. Aşağıdaki “+ Paket” ile ekle.</li>';

  // Gider listesi
  $('exList').innerHTML = ex.length ? ex.map(e => `
    <li><button class="rec" data-kind="expenses" data-id="${e.id}">
      <span class="rec-main">
        <span class="rec-title">${esc(e.category)}</span>
        <span class="rec-sub">${esc(e.time)}${e.note ? ' · ' + esc(e.note) : ''}</span>
      </span>
      <span class="rec-amount bad">−${money(e.amount)}</span>
    </button></li>`).join('')
    : '<li class="empty">Gider yok.</li>';

  renderQuickRow();

  // "Bu hafta" şeridi (gösterilen günün haftası)
  const ws = weekStartOf(day);
  const w = (await loadRange(ws, addDays(ws, 6))).totals;
  $('weekStrip').innerHTML = `<span>${ws === weekStartOf(state.today) ? 'Bu hafta' : 'O hafta'} · ${w.count} paket</span>
    <b class="${w.net < 0 ? 'bad' : 'good'}">${money(w.net)} net ›</b>`;
}

/** Hızlı tutar butonları: tek dokunuşla paket ekler */
function renderQuickRow() {
  $('quickRow').innerHTML = state.quickAmounts.length
    ? state.quickAmounts.map(a => `<button class="quick-btn" data-amount="${a}">${moneyFmt.format(a)}</button>`).join('')
    : '<span class="quick-hint">Sık kullandığın tutarlar burada tek dokunuş butonu olarak çıkacak.</span>';
}

/** Son ve en sık kullanılan tutarları hesaplar (son 300 paket üzerinden) */
async function refreshQuickAmounts() {
  const all = await DB.all('packages');
  all.sort((a, b) => b.createdAt - a.createdAt);
  const recent = all.slice(0, 300);
  const freq = new Map(), lastSeen = new Map();
  recent.forEach((p, i) => {
    freq.set(p.amount, (freq.get(p.amount) || 0) + 1);
    if (!lastSeen.has(p.amount)) lastSeen.set(p.amount, i);
  });
  // En sık olanlar önce; eşitlikte en yeni olan önce
  const byFreq = [...freq.keys()].sort((a, b) => freq.get(b) - freq.get(a) || lastSeen.get(a) - lastSeen.get(b));
  const list = [];
  if (recent.length) list.push(recent[0].amount); // en son kullanılan tutar her zaman ilk sırada
  for (const a of byFreq) { if (!list.includes(a)) list.push(a); if (list.length >= 6) break; }
  state.quickAmounts = list;
}

/** Kayıt eklerken kullanılacak saat: bugünse şimdiki saat, geçmiş günde de şimdiki saat (düzenlenebilir) */
const defaultTime = () => nowTime();

/** Tek dokunuşla paket ekleme (hızlı buton) */
async function quickAddPackage(amount) {
  const rec = { day: state.day, time: defaultTime(), amount, note: '', createdAt: Date.now() };
  rec.id = await DB.put('packages', rec);
  await refreshQuickAmounts();
  await renderToday();
  const no = (await DB.range('packages', rec.day, rec.day)).sort(cmpRecords).findIndex(p => p.id === rec.id) + 1;
  toast(`${no}. paket eklendi · ${money(amount)}`, 'Geri al', async () => {
    await DB.del('packages', rec.id);
    await refreshQuickAmounts();
    renderToday();
    toast('Geri alındı');
  });
}

/* ----- Paket formu ----- */
async function openPackageForm(rec) {
  state.editing = rec || null;
  // Alanlar önce (senkron) doldurulur; veritabanı sorgusu sadece başlık için.
  // Böylece kullanıcı hızlı yazmaya başlarsa girdiği tutar silinmez.
  $('pkTitle').textContent = rec ? 'Paketi düzenle' : 'Paket ekle';
  $('pkAmount').value = rec ? moneyFmt.format(rec.amount) : '';
  $('pkTime').value = rec ? rec.time : defaultTime();
  $('pkNote').value = rec ? rec.note || '' : '';
  $('pkDelete').hidden = !rec;
  $('pkChips').innerHTML = state.quickAmounts
    .map(a => `<button type="button" class="chip" data-amount="${a}">${moneyFmt.format(a)} ₺</button>`).join('');
  openSheet($('pkSheet'));
  if (!rec) {
    const count = (await DB.range('packages', state.day, state.day)).length;
    if (state.editing === null) $('pkTitle').textContent = `${count + 1}. paket`;
  }
}
/** "+ Paket" butonu: pencereyi aç ve klavye açılsın diye tutara odaklan.
    (iPhone'da klavyenin açılması için odaklama, dokunma anında senkron yapılmalı) */
function onAddPackageClick() {
  $('pkSheet').hidden = false;
  $('pkAmount').value = '';
  $('pkAmount').focus();
  openPackageForm(null);
}

async function savePackage(ev) {
  ev.preventDefault();
  const amount = parseAmount($('pkAmount').value);
  if (!(amount > 0)) { toast('Geçerli bir tutar gir'); $('pkAmount').focus(); return; }
  const old = state.editing;
  const rec = old
    ? { ...old, amount, time: $('pkTime').value || old.time, note: $('pkNote').value.trim() }
    : { day: state.day, time: $('pkTime').value || nowTime(), amount, note: $('pkNote').value.trim(), createdAt: Date.now() };
  await DB.put('packages', rec);
  closeSheet();
  await refreshQuickAmounts();
  await renderToday();
  toast(old ? 'Paket güncellendi' : `Paket eklendi · ${money(amount)}`);
}

async function deletePackage() {
  const rec = state.editing;
  if (!rec) return;
  const ok = await confirmDialog(`${money(rec.amount)} tutarındaki paket silinsin mi?`, 'Sil');
  if (!ok) return;
  await DB.del('packages', rec.id);
  closeSheet();
  await refreshQuickAmounts();
  await renderToday();
  toast('Paket silindi');
}

/* ----- Gider formu ----- */
const allCategories = () => [...DEFAULT_CATEGORIES, ...state.settings.customCategories];

function renderCategoryChips() {
  $('exCats').innerHTML = allCategories()
    .map(c => `<button type="button" class="chip${c === state.exCategory ? ' active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`)
    .join('') + '<button type="button" class="chip" data-newcat="1">+ Yeni</button>';
}

function openExpenseForm(rec) {
  state.editing = rec || null;
  state.exCategory = rec ? rec.category
    : (allCategories().includes(state.settings.lastCategory) ? state.settings.lastCategory : 'Yakıt');
  $('exTitle').textContent = rec ? 'Gideri düzenle' : 'Gider ekle';
  $('exAmount').value = rec ? moneyFmt.format(rec.amount) : '';
  $('exTime').value = rec ? rec.time : defaultTime();
  $('exNote').value = rec ? rec.note || '' : '';
  $('exDelete').hidden = !rec;
  $('exNewCatRow').hidden = true;
  renderCategoryChips();
  openSheet($('exSheet'));
}
function onAddExpenseClick() {
  $('exSheet').hidden = false;
  $('exAmount').value = '';
  $('exAmount').focus();
  openExpenseForm(null);
}

async function saveExpense(ev) {
  ev.preventDefault();
  const amount = parseAmount($('exAmount').value);
  if (!(amount > 0)) { toast('Geçerli bir tutar gir'); $('exAmount').focus(); return; }
  const category = state.exCategory || 'Diğer';
  const old = state.editing;
  const rec = old
    ? { ...old, amount, category, time: $('exTime').value || old.time, note: $('exNote').value.trim() }
    : { day: state.day, time: $('exTime').value || nowTime(), amount, category, note: $('exNote').value.trim(), createdAt: Date.now() };
  await DB.put('expenses', rec);
  await saveSetting('lastCategory', category);
  closeSheet();
  await renderToday();
  toast(old ? 'Gider güncellendi' : `Gider eklendi · ${category} ${money(amount)}`);
}

async function deleteExpense() {
  const rec = state.editing;
  if (!rec) return;
  const ok = await confirmDialog(`${rec.category} – ${money(rec.amount)} gideri silinsin mi?`, 'Sil');
  if (!ok) return;
  await DB.del('expenses', rec.id);
  closeSheet();
  await renderToday();
  toast('Gider silindi');
}

async function addCustomCategory(name) {
  name = String(name || '').trim();
  if (!name) return false;
  const exists = allCategories().some(c => c.toLocaleLowerCase('tr-TR') === name.toLocaleLowerCase('tr-TR'));
  if (exists) { toast('Bu kategori zaten var'); return false; }
  await saveSetting('customCategories', [...state.settings.customCategories, name]);
  return true;
}

/* ---------------------------------------------------------
   7) ÖZET HESAPLAMALARI
   --------------------------------------------------------- */
/** Bir tarih aralığındaki kayıtları gün gün toplar */
async function loadRange(from, to) {
  const [pk, ex] = await Promise.all([DB.range('packages', from, to), DB.range('expenses', from, to)]);
  const days = new Map();
  const dayOf = k => {
    if (!days.has(k)) days.set(k, { day: k, count: 0, income: 0, expense: 0, net: 0 });
    return days.get(k);
  };
  const cats = new Map();
  for (const p of pk) { const d = dayOf(p.day); d.count++; d.income += p.amount; }
  for (const e of ex) {
    dayOf(e.day).expense += e.amount;
    cats.set(e.category, (cats.get(e.category) || 0) + e.amount);
  }
  const t = { count: 0, income: 0, expense: 0, net: 0, workedDays: 0, best: null };
  for (const d of days.values()) {
    d.income = round2(d.income); d.expense = round2(d.expense); d.net = round2(d.income - d.expense);
    t.count += d.count; t.income += d.income; t.expense += d.expense;
    if (d.count > 0) {
      t.workedDays++; // paket attığı gün = çalışılan gün
      if (!t.best || d.net > t.best.net) t.best = d;
    }
  }
  t.income = round2(t.income); t.expense = round2(t.expense); t.net = round2(t.income - t.expense);
  t.avgDailyNet = t.workedDays ? round2(t.net / t.workedDays) : 0;
  t.avgPerPackage = t.count ? round2(t.income / t.count) : 0;
  const categories = [...cats.entries()].map(([name, amount]) => ({ name, amount: round2(amount) }))
    .sort((a, b) => b.amount - a.amount);
  return { days, totals: t, categories, packages: pk, expenses: ex };
}

/** Basit SVG çubuk grafik (harici kütüphane yok). Eksi değerler kırmızı. */
function barChart(items) {
  const W = 340, H = 170, top = 16, bottom = 22, side = 2;
  const vals = items.map(i => i.value);
  const max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  const span = (max - min) || 1;
  const ch = H - top - bottom;
  const y = v => top + ((max - v) / span) * ch;
  const slot = (W - side * 2) / items.length;
  const bw = Math.max(2, slot * 0.68);
  let bars = '', hits = '', labels = '';
  items.forEach((it, i) => {
    const x = side + i * slot;
    if (it.value !== 0) {
      const y1 = Math.min(y(it.value), y(0));
      const h = Math.max(1.5, Math.abs(y(it.value) - y(0)));
      bars += `<rect class="${it.value < 0 ? 'bar-neg' : 'bar-pos'}" x="${(x + (slot - bw) / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"/>`;
    }
    if (it.key) hits += `<rect class="hit" data-key="${it.key}" x="${x.toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H}"><title>${esc(it.title || '')}</title></rect>`;
    if (it.showLabel) labels += `<text x="${(x + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(it.label)}</text>`;
  });
  const zeroY = y(0).toFixed(1);
  const maxLabel = max > 0 ? `<text x="${side}" y="11">${esc(money(max))}</text>` : '';
  const minLabel = min < 0 ? `<text x="${W - side}" y="${(H - bottom - 4)}" text-anchor="end">${esc(money(min))}</text>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Günlük net kazanç grafiği">
    <line class="axis" x1="0" x2="${W}" y1="${zeroY}" y2="${zeroY}"/>${bars}${labels}${maxLabel}${minLabel}${hits}</svg>`;
}

/** Özet kartları (net, paket, kazanç, gider ...) */
function totalsHtml(t, extra = true) {
  return `
    <section class="card net-card summary-net">
      <div class="card-label">NET KAZANÇ</div>
      <div class="net-value${t.net < 0 ? ' negative' : ''}">${money(t.net)}</div>
    </section>
    <section class="stat-grid two">
      <div class="card stat"><div class="card-label">Kazanç</div><div class="stat-value good">${money(t.income)}</div></div>
      <div class="card stat"><div class="card-label">Gider</div><div class="stat-value bad">${money(t.expense)}</div></div>
    </section>
    <section class="card block"><ul class="kv-list">
      <li><span>Toplam paket</span><b>${t.count}</b></li>
      ${extra ? `<li><span>Çalıştığım gün</span><b>${t.workedDays}</b></li>
      <li><span>Günlük ortalama net</span><b>${money(t.avgDailyNet)}</b></li>
      <li><span>Paket başı ortalama ücret</span><b>${money(t.avgPerPackage)}</b></li>` : ''}
    </ul></section>`;
}

function bestDayHtml(t) {
  if (!t.best) return '';
  return `<section class="card block">
    <div class="card-label">EN ÇOK KAZANDIĞIM GÜN</div>
    <button class="best-day rec" data-goday="${t.best.day}" style="border:0;padding:8px 0 0;background:none">
      <span class="rec-main"><span class="rec-title">${esc(fmtLong(t.best.day))}</span>
      <span class="rec-sub">${t.best.count} paket</span></span>
      <span class="rec-amount good">${money(t.best.net)}</span>
    </button></section>`;
}

function categoriesHtml(categories, totalExpense) {
  if (!categories.length) return '';
  return `<section class="card block"><div class="card-label">GİDER DAĞILIMI</div>
    ${categories.map(c => {
      const pct = totalExpense ? Math.round(c.amount / totalExpense * 100) : 0;
      return `<div class="cat-row"><div class="cat-row-top"><span>${esc(c.name)}</span>
        <b>${money(c.amount)} <span class="muted">· %${pct}</span></b></div>
        <div class="cat-bar"><div style="width:${pct}%"></div></div></div>`;
    }).join('')}</section>`;
}

/** Günlük döküm tablosu: satıra dokununca o gün açılır */
function breakdownHtml(dayList) {
  if (!dayList.length) return '';
  return `<section class="card block"><div class="card-label">GÜNLÜK DÖKÜM</div>
    <table class="breakdown"><thead><tr><th>Gün</th><th>Paket</th><th>Kazanç ₺</th><th>Gider ₺</th><th>Net ₺</th></tr></thead>
    <tbody>${dayList.map(d => `<tr data-goday="${d.day}">
      <td>${esc(fmtShort(d.day))}</td><td>${d.count}</td><td>${plain(d.income)}</td>
      <td>${plain(d.expense)}</td><td class="net ${d.net < 0 ? 'bad' : 'good'}">${plain(d.net)}</td></tr>`).join('')}
    </tbody></table></section>`;
}

/* ---------------------------------------------------------
   8) ÖZET EKRANI (Hafta / Ay / Yıl)
   --------------------------------------------------------- */
async function renderSummary() {
  document.querySelectorAll('#summaryMode button').forEach(b => b.classList.toggle('active', b.dataset.mode === state.summaryMode));
  const body = $('summaryBody');
  const thisMonth = state.today.slice(0, 7);

  if (state.summaryMode === 'month') {
    const m = state.month;
    $('periodLabel').textContent = fmtMonth(m);
    $('nextPeriod').disabled = m >= thisMonth;
    const r = await loadRange(m + '-01', m + '-31');
    const n = daysInMonth(m);
    const items = [];
    for (let i = 1; i <= n; i++) {
      const k = `${m}-${pad(i)}`, d = r.days.get(k);
      items.push({ key: d ? k : null, value: d ? d.net : 0, label: String(i),
        showLabel: i === 1 || i % 5 === 0, title: d ? `${fmtShort(k)}: ${money(d.net)}` : '' });
    }
    const dayList = [...r.days.values()].sort((a, b) => b.day.localeCompare(a.day));
    body.innerHTML = totalsHtml(r.totals)
      + bestDayHtml(r.totals)
      + `<section class="card block"><div class="card-label">GÜNLÜK NET KAZANÇ</div>${barChart(items)}</section>`
      + categoriesHtml(r.categories, r.totals.expense)
      + breakdownHtml(dayList)
      + `<button class="btn btn-secondary btn-block" id="csvMonthBtn">📄 Bu ayı CSV (Excel) indir</button>`
      + (dayList.length ? '' : '<p class="empty center">Bu ayda kayıt yok.</p>');
    return;
  }

  if (state.summaryMode === 'week') {
    const from = state.week, to = addDays(from, 6);
    const thisWeek = weekStartOf(state.today);
    $('periodLabel').textContent = from === thisWeek ? 'Bu hafta' : `${fmtShort(from)} – ${fmtShort(to)}`;
    $('nextPeriod').disabled = from >= thisWeek;
    const r = await loadRange(from, to);
    const items = [], dayList = [];
    for (let i = 0; i < 7; i++) {
      const k = addDays(from, i), d = r.days.get(k);
      items.push({ key: d ? k : null, value: d ? d.net : 0, showLabel: true,
        label: shortDateFmt.formatToParts(keyToDate(k)).find(p => p.type === 'weekday').value,
        title: d ? money(d.net) : '' });
      if (d) dayList.push(d);
    }
    body.innerHTML = `<p class="hint center">${esc(fmtLong(from))} – ${esc(fmtLong(to))}</p>`
      + totalsHtml(r.totals) + bestDayHtml(r.totals)
      + `<section class="card block"><div class="card-label">GÜNLÜK NET KAZANÇ</div>${barChart(items)}</section>`
      + categoriesHtml(r.categories, r.totals.expense)
      + breakdownHtml(dayList.reverse());
    return;
  }

  // Yıllık: aylara göre özet
  const y = state.year;
  $('periodLabel').textContent = String(y);
  $('nextPeriod').disabled = y >= Number(state.today.slice(0, 4));
  const r = await loadRange(`${y}-01-01`, `${y}-12-31`);
  const months = [];
  for (let i = 1; i <= 12; i++) months.push({ month: `${y}-${pad(i)}`, count: 0, income: 0, expense: 0, net: 0, days: 0 });
  for (const d of r.days.values()) {
    const mo = months[Number(d.day.slice(5, 7)) - 1];
    mo.count += d.count; mo.income += d.income; mo.expense += d.expense; if (d.count) mo.days++;
  }
  months.forEach(mo => { mo.income = round2(mo.income); mo.expense = round2(mo.expense); mo.net = round2(mo.income - mo.expense); });
  const items = months.map(mo => ({ key: mo.count || mo.expense ? mo.month : null, value: mo.net, showLabel: true,
    label: monthShortFmt.format(keyToDate(mo.month + '-01')).slice(0, 3), title: `${fmtMonth(mo.month)}: ${money(mo.net)}` }));
  const active = months.filter(mo => mo.count || mo.expense).reverse();
  body.innerHTML = totalsHtml(r.totals)
    + `<section class="card block"><div class="card-label">AYLIK NET KAZANÇ</div>${barChart(items)}</section>`
    + categoriesHtml(r.categories, r.totals.expense)
    + (active.length ? `<section class="card block"><div class="card-label">AYLARA GÖRE</div>
      <table class="breakdown"><thead><tr><th>Ay</th><th>Paket</th><th>Kazanç ₺</th><th>Gider ₺</th><th>Net ₺</th></tr></thead>
      <tbody>${active.map(mo => `<tr data-gomonth="${mo.month}">
        <td>${esc(cap(monthFmt.format(keyToDate(mo.month + '-01')).split(' ')[0]))}<span class="sub">${mo.days} gün</span></td>
        <td>${mo.count}</td><td>${plain(mo.income)}</td><td>${plain(mo.expense)}</td>
        <td class="net ${mo.net < 0 ? 'bad' : 'good'}">${plain(mo.net)}</td></tr>`).join('')}
      </tbody></table></section>` : '<p class="empty center">Bu yılda kayıt yok.</p>');
}

function shiftPeriod(dir) {
  if (state.summaryMode === 'month') state.month = addMonths(state.month, dir);
  else if (state.summaryMode === 'week') state.week = addDays(state.week, 7 * dir);
  else state.year += dir;
  renderSummary();
}

/** Özet ekranından bir güne dokununca Bugün ekranında o günü aç */
function goToDay(k) {
  state.day = k;
  showTab('today');
}

/* ---------------------------------------------------------
   9) AYARLAR, YEDEKLEME, CSV
   --------------------------------------------------------- */
async function renderSettings() {
  document.querySelectorAll('#themeSeg button').forEach(b => b.classList.toggle('active', b.dataset.theme === state.settings.theme));
  $('dayStartInput').value = state.settings.dayStart;
  $('csvMonth').value = state.month;
  $('customCatList').innerHTML = state.settings.customCategories.length
    ? state.settings.customCategories.map((c, i) => `<li><span>${esc(c)}</span>
        <button class="icon-btn" data-delcat="${i}" aria-label="${esc(c)} kategorisini kaldır">✕</button></li>`).join('')
    : '<li class="empty">Henüz kendi kategorin yok.</li>';
  const [np, ne] = await Promise.all([DB.count('packages'), DB.count('expenses')]);
  $('dbInfo').textContent = `Kayıtlı: ${np} paket, ${ne} gider.`;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', theme === 'light' ? '#f3f4f6' : '#111418');
  try { localStorage.setItem('kk-theme', theme); } catch (e) { /* gizli sekmede olabilir */ }
}

/** Tüm verileri JSON olarak dışa aktar */
async function exportBackup() {
  const [packages, expenses, settings] = await Promise.all([DB.all('packages'), DB.all('expenses'), DB.all('settings')]);
  const data = { app: 'kurye-kazanc', version: 1, exportedAt: new Date().toISOString(), packages, expenses, settings };
  const stamp = dateToKey(new Date());
  downloadFile(`kurye-kazanc-yedek-${stamp}.json`, JSON.stringify(data, null, 1), 'application/json');
  toast(`Yedek indirildi (${packages.length} paket, ${expenses.length} gider)`);
}

/** Yedekteki kayıtların doğru biçimde olduğunu kontrol eder */
function validRecord(r, kind) {
  return r && typeof r === 'object'
    && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && /^\d{2}:\d{2}$/.test(r.time)
    && typeof r.amount === 'number' && r.amount >= 0
    && (kind === 'packages' || typeof r.category === 'string');
}

/** JSON yedeğini içe aktarır (mevcut verilerin yerine geçer) */
async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('Dosya okunamadı: geçerli bir yedek değil'); return; }
  if (!data || data.app !== 'kurye-kazanc' || !Array.isArray(data.packages) || !Array.isArray(data.expenses)) {
    toast('Bu dosya Kurye Kazanç yedeği değil'); return;
  }
  const pk = data.packages.filter(r => validRecord(r, 'packages'));
  const ex = data.expenses.filter(r => validRecord(r, 'expenses'));
  const ok = await confirmDialog(
    `Yedekte ${pk.length} paket ve ${ex.length} gider var.\nŞu anki veriler silinip yedektekiler yüklenecek. Devam edilsin mi?`, 'Yükle');
  if (!ok) return;
  const tx = db.transaction(['packages', 'expenses', 'settings'], 'readwrite');
  for (const name of ['packages', 'expenses']) tx.objectStore(name).clear();
  pk.forEach(r => tx.objectStore('packages').put({ ...r, createdAt: r.createdAt || Date.now() }));
  ex.forEach(r => tx.objectStore('expenses').put({ ...r, createdAt: r.createdAt || Date.now() }));
  if (Array.isArray(data.settings)) {
    data.settings.filter(s => s && typeof s.key === 'string').forEach(s => tx.objectStore('settings').put(s));
  }
  await txDone(tx);
  await loadSettings();
  applyTheme(state.settings.theme);
  await refreshQuickAmounts();
  state.today = workDayOf();
  toast(`Yedek yüklendi: ${pk.length} paket, ${ex.length} gider`);
  render();
}

/** Seçilen ayın verisini Excel'de açılabilen CSV olarak indirir.
    Türkçe Excel için: ";" ayraç, "," ondalık, UTF-8 BOM (Türkçe karakterler bozulmasın). */
async function exportCsv(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) { toast('Önce bir ay seç'); return; }
  const r = await loadRange(month + '-01', month + '-31');
  const cell = v => { v = String(v ?? ''); return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const num = n => round2(n).toFixed(2).replace('.', ',');
  const trDate = k => k.split('-').reverse().join('.');
  const weekday = k => cap(new Intl.DateTimeFormat('tr-TR', { weekday: 'long' }).format(keyToDate(k)));
  const lines = [['Tarih', 'Gün', 'Saat', 'Tür', 'Paket No', 'Kategori', 'Tutar', 'Not'].join(';')];

  // Gün gün detay satırları
  const dayKeys = [...r.days.keys()].sort();
  for (const k of dayKeys) {
    const pk = r.packages.filter(p => p.day === k).sort(cmpRecords);
    const ex = r.expenses.filter(e => e.day === k).sort(cmpRecords);
    pk.forEach((p, i) => lines.push([trDate(k), weekday(k), p.time, 'Paket', i + 1, '', num(p.amount), p.note].map(cell).join(';')));
    ex.forEach(e => lines.push([trDate(k), weekday(k), e.time, 'Gider', '', e.category, num(-e.amount), e.note].map(cell).join(';')));
  }
  // Günlük özet
  lines.push('', 'GÜNLÜK ÖZET', ['Tarih', 'Gün', 'Paket', 'Kazanç', 'Gider', 'Net'].join(';'));
  for (const k of dayKeys) {
    const d = r.days.get(k);
    lines.push([trDate(k), weekday(k), d.count, num(d.income), num(d.expense), num(d.net)].map(cell).join(';'));
  }
  const t = r.totals;
  lines.push(['TOPLAM', '', t.count, num(t.income), num(t.expense), num(t.net)].map(cell).join(';'));
  downloadFile(`kurye-kazanc-${month}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  toast(`${fmtMonth(month)} CSV indirildi`);
}

/** Tüm verileri sil — iki kez onay ister */
async function wipeAll() {
  if (!await confirmDialog('Tüm paket, gider ve ayarlar silinecek. Emin misin?', 'Evet, sil')) return;
  if (!await confirmDialog('SON UYARI: Bu işlem geri alınamaz!\nYedek almadıysan önce “Yedeği dışa aktar”ı kullan.\nYine de her şey silinsin mi?', 'Hepsini sil')) return;
  const tx = db.transaction(['packages', 'expenses', 'settings'], 'readwrite');
  ['packages', 'expenses', 'settings'].forEach(n => tx.objectStore(n).clear());
  await txDone(tx);
  state.settings = { ...DEFAULT_SETTINGS, customCategories: [] };
  applyTheme('dark');
  state.quickAmounts = [];
  toast('Tüm veriler silindi');
  render();
}

/* ---------------------------------------------------------
   10) OLAY BAĞLANTILARI
   --------------------------------------------------------- */
function bindEvents() {
  // Sekmeler
  document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // Gün gezinme
  $('prevDay').addEventListener('click', () => { state.day = addDays(state.day, -1); renderToday(); });
  $('nextDay').addEventListener('click', () => { if (state.day < state.today) { state.day = addDays(state.day, 1); renderToday(); } });
  $('backToToday').addEventListener('click', () => { state.day = state.today; renderToday(); });
  $('dayTitle').addEventListener('click', () => {
    const p = $('datePicker');
    try { p.showPicker(); } catch { p.focus(); p.click(); }
  });
  $('datePicker').addEventListener('change', e => {
    const v = e.target.value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { state.day = v > state.today ? state.today : v; renderToday(); }
  });

  // Ekleme butonları
  $('weekStrip').addEventListener('click', () => {
    state.week = weekStartOf(state.day); state.summaryMode = 'week'; showTab('summary');
  });
  $('addPackageBtn').addEventListener('click', onAddPackageClick);
  $('addExpenseBtn').addEventListener('click', onAddExpenseClick);
  $('quickRow').addEventListener('click', e => {
    const b = e.target.closest('[data-amount]');
    if (b) quickAddPackage(Number(b.dataset.amount));
  });

  // Listedeki kayda dokununca düzenleme penceresi
  ['pkList', 'exList'].forEach(id => $(id).addEventListener('click', async e => {
    const b = e.target.closest('.rec[data-id]');
    if (!b) return;
    const rec = await DB.get(b.dataset.kind, Number(b.dataset.id));
    if (!rec) return;
    b.dataset.kind === 'packages' ? openPackageForm(rec) : openExpenseForm(rec);
  }));

  // Paket formu
  $('pkForm').addEventListener('submit', savePackage);
  $('pkDelete').addEventListener('click', deletePackage);
  $('pkChips').addEventListener('click', e => {
    const b = e.target.closest('[data-amount]');
    if (b) { $('pkAmount').value = moneyFmt.format(Number(b.dataset.amount)); }
  });

  // Gider formu
  $('exForm').addEventListener('submit', saveExpense);
  $('exDelete').addEventListener('click', deleteExpense);
  $('exCats').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if (b.dataset.newcat) { $('exNewCatRow').hidden = false; $('exNewCat').value = ''; $('exNewCat').focus(); return; }
    state.exCategory = b.dataset.cat;
    renderCategoryChips();
  });
  const saveNewCatFromSheet = async () => {
    const name = $('exNewCat').value.trim();
    if (await addCustomCategory(name)) {
      state.exCategory = name;
      $('exNewCatRow').hidden = true;
      renderCategoryChips();
      $('exAmount').focus();
    }
  };
  $('exNewCatSave').addEventListener('click', saveNewCatFromSheet);
  $('exNewCat').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveNewCatFromSheet(); } });

  // Pencereleri kapatma: ✕ butonu veya karartılmış alana dokunma
  document.querySelectorAll('.overlay:not(.center)').forEach(ov => ov.addEventListener('click', e => {
    if (e.target === ov || e.target.closest('[data-close]')) closeSheet();
  }));
  $('confirmYes').addEventListener('click', () => closeConfirm(true));
  $('confirmNo').addEventListener('click', () => closeConfirm(false));
  $('confirmBox').addEventListener('click', e => { if (e.target === $('confirmBox')) closeConfirm(false); });

  // Özet ekranı
  $('summaryMode').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (b) { state.summaryMode = b.dataset.mode; renderSummary(); }
  });
  $('prevPeriod').addEventListener('click', () => shiftPeriod(-1));
  $('nextPeriod').addEventListener('click', () => shiftPeriod(1));
  $('summaryBody').addEventListener('click', e => {
    const d = e.target.closest('[data-goday], [data-key]');
    const mo = e.target.closest('[data-gomonth]');
    if (e.target.closest('#csvMonthBtn')) return exportCsv(state.month);
    if (mo) { state.month = mo.dataset.gomonth; state.summaryMode = 'month'; return renderSummary(); }
    if (d) {
      const k = d.dataset.goday || d.dataset.key;
      if (/^\d{4}-\d{2}$/.test(k)) { state.month = k; state.summaryMode = 'month'; return renderSummary(); } // yıllık grafikte ay çubuğu
      goToDay(k);
    }
  });

  // Ayarlar
  $('themeSeg').addEventListener('click', async e => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    await saveSetting('theme', b.dataset.theme);
    applyTheme(b.dataset.theme);
    renderSettings();
  });
  $('dayStartInput').addEventListener('change', async e => {
    if (!/^\d{2}:\d{2}$/.test(e.target.value)) return;
    const wasToday = state.day === state.today;
    await saveSetting('dayStart', e.target.value);
    state.today = workDayOf();
    if (wasToday) state.day = state.today;
    toast(`Gün başlangıcı ${e.target.value} olarak kaydedildi`);
  });
  $('addCatForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (await addCustomCategory($('newCatInput').value)) { $('newCatInput').value = ''; renderSettings(); toast('Kategori eklendi'); }
  });
  $('customCatList').addEventListener('click', async e => {
    const b = e.target.closest('[data-delcat]');
    if (!b) return;
    const list = [...state.settings.customCategories];
    const name = list[Number(b.dataset.delcat)];
    if (!await confirmDialog(`“${name}” kategorisi listeden kaldırılsın mı?\n(Eski giderler silinmez.)`, 'Kaldır')) return;
    list.splice(Number(b.dataset.delcat), 1);
    await saveSetting('customCategories', list);
    renderSettings();
  });
  $('exportBtn').addEventListener('click', exportBackup);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await importBackup(f);
  });
  $('csvBtn').addEventListener('click', () => exportCsv($('csvMonth').value));
  $('wipeBtn').addEventListener('click', wipeAll);

  // Uygulama arka plandan dönünce gün değişmişse "Bugün"ü güncelle
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const newToday = workDayOf();
    if (newToday !== state.today) {
      const wasToday = state.day === state.today;
      state.today = newToday;
      if (wasToday) state.day = newToday;
      render();
    }
  });
}

/* ---------------------------------------------------------
   11) BAŞLANGIÇ
   --------------------------------------------------------- */
async function init() {
  try {
    db = await openDB();
  } catch (err) {
    document.body.innerHTML = '<p style="padding:20px">Veritabanı açılamadı. Tarayıcı gizli modda olabilir.</p>';
    return;
  }
  await loadSettings();
  applyTheme(state.settings.theme);
  state.today = workDayOf();
  state.day = state.today;
  state.month = state.today.slice(0, 7);
  state.week = weekStartOf(state.today);
  state.year = Number(state.today.slice(0, 4));
  await refreshQuickAmounts();
  bindEvents();
  render();

  // Tarayıcıdan verilerin kalıcı saklanmasını iste (yer azalınca silinmesin)
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

// Çevrimdışı çalışma için service worker kaydı (göreli yol: GitHub Pages alt klasöründe de çalışır)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js').catch(() => {}));
}

init();
