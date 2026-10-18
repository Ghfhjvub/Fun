import {
  configured, auth, db,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut,
  doc, getDoc, getDocs, updateDoc, setDoc, deleteDoc, collection, query, where, orderBy, limitToLast,
  onSnapshot, writeBatch, serverTimestamp, increment
} from './firebase.js';
import { firebaseConfig } from './firebase-config.js';
import { t, tr, setLang } from './i18n.js';
import {
  COLORS, latin, esc, hm, dayLabel, listTime, initial, normEmail, validEmail, pad
} from './util.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const wide = () => window.matchMedia('(min-width:881px)').matches;
const isTouch = () => window.matchMedia('(pointer:coarse)').matches;

/* ---------- التفضيلات (محفوظة على هذا الجهاز) ---------- */
const PK = 'wonasa.prefs';
const P = { theme: 'auto', bubble: 'def', font: 'm', lang: 'ar', wp: 'dots', sound: true, enter: true };
try { Object.assign(P, JSON.parse(localStorage.getItem(PK) || '{}')); } catch (e) { /* ignore */ }
const savePrefs = () => { try { localStorage.setItem(PK, JSON.stringify(P)); } catch (e) { /* ignore */ } };
function applyPrefs() {
  const r = document.documentElement;
  setLang(P.lang);
  if (P.theme === 'auto') r.removeAttribute('data-theme'); else r.dataset.theme = P.theme;
  r.dataset.bubble = P.bubble; r.dataset.font = P.font;
  const wpEl = document.getElementById('msgs');
  if (wpEl && typeof wpCss === 'function') wpEl.style.cssText = wpCss(P.wp).join(';');
  tr();
}

/* ---------- state ---------- */
const S = {
  uid: null, email: '', me: null,
  chats: new Map(),            // chatId -> chat document
  people: new Map(),           // uid -> user document (live)
  peopleUnsubs: new Map(),
  activeId: null, activeOther: null,
  draft: null,                 // محادثة جديدة لم تُرسل فيها رسالة بعد: {id, other}
  msgs: [],
  unsubChats: null, unsubMsgs: null,
  hb: null, clock: null, autoOpened: false,
  uploads: [],                 // فيديوهات قيد الإرسال: {id, chatId, progress}
  stories: new Map(), stDocs: new Map(), stUnsubs: [], stKey: '', stDel: new Set(), chatsReady: false
};
const NC = new Map();          // مفتاح الرسالة -> عنصر DOM (لا نعيد بناء الفيديو أثناء تشغيله)
const VID = new Map();         // معرّف رسالة الفيديو -> رابط blob جاهز للتشغيل
const VIDLOAD = new Set();
const MAX_VIDEO = 15 * 1024 * 1024;
const CHUNK = 700000;          // حجم القطعة (أحرف base64) تحت حد 1MB للمستند
const A = { color: COLORS[0] };

/* ---------- views + small UI helpers ---------- */
function view(name) {
  ['loading', 'auth', 'app', 'setup'].forEach(v => { $('#' + v).hidden = v !== name; });
  $('#root').classList.toggle('is-app', name === 'app');
  if (window.__wonasaReady) window.__wonasaReady();
}
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
}
function busy(btn, on) {
  btn.setAttribute('aria-busy', String(on));
  if (!btn.matches('#resend')) btn.disabled = on;
}
const AUTH_ERR = {
  'auth/too-many-requests': 'محاولات كثيرة. انتظر قليلاً ثم حاول من جديد.',
  'auth/network-request-failed': 'تعذر الاتصال بالإنترنت. تحقق من الشبكة.',
  'auth/operation-not-allowed': 'الدخول بحساب Google غير مفعّل. فعّله من Firebase ثم Authentication ثم Sign-in method.',
  'auth/unauthorized-domain': 'هذا النطاق غير مضاف إلى النطاقات المصرّح بها في Firebase Authentication.',
  'auth/user-disabled': 'هذا الحساب موقوف.',
  'auth/account-exists-with-different-credential': 'يوجد حساب بنفس البريد بطريقة دخول أخرى.',
  'auth/web-storage-unsupported': 'المتصفح يمنع التخزين المحلي. فعّل ملفات تعريف الارتباط أو جرّب متصفحاً آخر.'
};
function authError(err) {
  console.error(err);
  return t(AUTH_ERR[err && err.code] || 'حدث خطأ غير متوقع. حاول مرة ثانية.');
}

/* =====================================================================
   1) تسجيل الدخول بحساب Google
   ===================================================================== */
function go(n) {
  $('#s1').hidden = n !== 1; $('#s3').hidden = n !== 2;
  $$('#steps .seg').forEach((el, i) => { el.classList.toggle('on', i < n); el.classList.toggle('cur', i === n - 1); });
  if (n === 2) setTimeout(() => { try { $('#pName').focus(); } catch (e) { /* ignore */ } }, 30);
}
const googleProvider = () => {
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: 'select_account' });
  return p;
};

$('#s1').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#s1 button[type=submit]');
  $('#e1').textContent = '';
  busy(btn, true);
  try {
    await signInWithPopup(auth, googleProvider());
    // عند النجاح يتولى onAuthStateChanged نقل المستخدم للشاشة التالية
  } catch (err) {
    const code = err && err.code;
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') { /* أغلق النافذة، لا خطأ */ }
    else if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      try { await signInWithRedirect(auth, googleProvider()); return; }
      catch (e2) { $('#e1').textContent = authError(e2); }
    } else $('#e1').textContent = authError(err);
  } finally { busy(btn, false); }
});

/* الملف الشخصي (للحسابات الجديدة فقط) */
const sw = $('#swatches');
sw.innerHTML = COLORS.map(c =>
  '<button type="button" class="sw" style="--c:' + c + '" data-c="' + c + '" aria-label="' + t('لون') + '" aria-pressed="' + (c === A.color) + '"></button>').join('');
function paintProfile() {
  const pa = $('#pAvatar');
  pa.style.setProperty('--c', A.color);
  pa.textContent = initial($('#pName').value);
  $$('.sw', sw).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.c === A.color)));
}
sw.addEventListener('click', e => { const b = e.target.closest('.sw'); if (!b) return; A.color = b.dataset.c; paintProfile(); });
$('#pName').addEventListener('input', paintProfile);
$('#notMe').addEventListener('click', () => signOut(auth));

$('#s3').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#pName').value.trim();
  if (name.length < 2) { $('#e3').textContent = t('اكتب اسماً من حرفين على الأقل.'); return; }
  $('#e3').textContent = '';
  const btn = $('#s3 button[type=submit]');
  busy(btn, true);
  try {
    const uid = S.uid;
    const userRef = doc(db, 'users', uid);
    const batch = writeBatch(db);
    batch.set(userRef, {
      name, email: S.email, color: A.color, status: $('#pStatus').value.trim(),
      createdAt: serverTimestamp(), lastSeen: serverTimestamp()
    });
    batch.set(doc(db, 'emails', S.email), { uid }); // فهرس للبحث عن الأصدقاء بالبريد
    await batch.commit();
    const snap = await getDoc(userRef);
    S.me = snap.data();
    startApp();
  } catch (err) {
    console.error(err);
    const code = (err && err.code) || (err && err.message) || '';
    const hint = /permission-denied/.test(code) ? t('القواعد ترفض الكتابة. انشر firestore.rules في نفس المشروع ') + firebaseConfig.projectId + '.'
      : /not-found|failed-precondition|unavailable/.test(code) ? t('قاعدة Firestore غير منشأة في هذا المشروع أو لا يمكن الوصول إليها. أنشئها من Firestore Database ثم Create database.')
      : t('تعذر حفظ الملف الشخصي.');
    $('#e3').textContent = hint + ' (' + code + ')';
  } finally { busy(btn, false); }
});

/* حالة الدخول: المصدر الوحيد لتحديد الشاشة */
function bootAuth() {
  // رجوع من تسجيل الدخول بالتحويل (يُستخدم عند حجب النافذة المنبثقة)
  getRedirectResult(auth).catch(err => {
    view('auth'); go(1); $('#e1').textContent = authError(err);
  });
  onAuthStateChanged(auth, async user => {
    if (!user) {
      teardown();
      S.uid = null; S.me = null; S.email = '';
      $('#pName').value = ''; $('#pStatus').value = '';
      A.color = COLORS[0]; paintProfile();
      view('auth'); go(1);
      return;
    }
    S.uid = user.uid;
    S.email = normEmail(user.email);
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (snap.exists()) { S.me = snap.data(); startApp(); }
      else {
        $('#pName').value = (user.displayName || '').trim().slice(0, 30);
        view('auth'); go(2); paintProfile();
      }
    } catch (err) {
      console.error(err);
      view('auth'); go(1);
      $('#e1').textContent = t('تعذر الاتصال بقاعدة البيانات. تأكد من إنشاء Firestore ونشر القواعد.');
    }
  });
}

/* =====================================================================
   2) المحادثات
   ===================================================================== */
const otherOf = c => c.members.find(x => x !== S.uid);
const person = uid => S.people.get(uid) || null;
const personName = uid => (person(uid) && person(uid).name) || '…';
const personColor = uid => (person(uid) && person(uid).color) || COLORS[4];
const millis = ts => (ts && ts.toMillis ? ts.toMillis() : 0);
const isOnline = p => !!(p && !p.hideOnline && p.lastSeen && Date.now() - millis(p.lastSeen) < 100000);
const rrOn = () => !S.me || S.me.readReceipts !== false;
const chatIdFor = (a, b) => [a, b].sort().join('_');

function ensurePerson(uid) {
  if (!uid || S.peopleUnsubs.has(uid)) return;
  const unsub = onSnapshot(doc(db, 'users', uid), snap => {
    S.people.set(uid, snap.exists() ? snap.data({ serverTimestamps: 'estimate' }) : null);
    renderList();
    if (S.activeOther === uid) renderThread();
  }, err => console.error(err));
  S.peopleUnsubs.set(uid, unsub);
}

function icon(kind) {
  const base = ' class="tick' + (kind === 'read' ? ' read' : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  if (kind === 'pending') return '<svg' + base + ' aria-label="' + t('جارٍ الإرسال') + '"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/></svg>';
  if (kind === 'sent') return '<svg' + base + ' aria-label="' + t('أُرسلت') + '"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
  return '<svg' + base + ' aria-label="' + t('قُرئت') + '"><path d="M2 12.5l4.5 4.5L15 8.5"/><path d="M9.5 15.5 11 17 21 7"/></svg>';
}

const PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const IMG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const AUD_RE = /^data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;
const okPhoto = p => typeof p === 'string' && p.length > 0 && p.length < 70000 && PHOTO_RE.test(p);
const okImg = p => typeof p === 'string' && p.length < 760000 && IMG_RE.test(p);
const okAudio = p => typeof p === 'string' && p.length < 760000 && AUD_RE.test(p);
function paintAv(el, name, color, photo) {
  el.style.setProperty('--c', color);
  if (okPhoto(photo)) { el.style.setProperty('--img', 'url("' + photo + '")'); el.classList.add('has-img'); el.textContent = ''; }
  else { el.style.removeProperty('--img'); el.classList.remove('has-img'); el.textContent = initial(name); }
}
const fmtDur = sec => { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + pad(sec % 60); };
const fmtMB = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';

function renderMe() {
  paintAv($('#meAv'), S.me.name, S.me.color, S.me.photo);
}

function items() {
  const arr = [...S.chats.values()].map(c => ({ id: c.id, other: otherOf(c), chat: c, ts: millis(c.lastTs) }));
  if (S.draft && !S.chats.has(S.draft.id)) arr.push({ id: S.draft.id, other: S.draft.other, chat: null, ts: Date.now() });
  return arr.sort((a, b) => b.ts - a.ts);
}

function renderList() {
  if (!S.uid) return;
  const q = latin($('#q').value).trim().toLowerCase();
  const list = items().filter(it => {
    if (!q) return true;
    const p = person(it.other);
    const last = it.chat && it.chat.lastMessage ? String(it.chat.lastMessage.text).toLowerCase() : '';
    return (p && String(p.name).toLowerCase().includes(q)) || (p && p.email && String(p.email).includes(q)) || last.includes(q);
  });
  const ul = $('#chats');
  if (!list.length) {
    ul.innerHTML = '<li class="no-res">' + (q ? t('لا توجد نتائج لهذا البحث.') : t('لا توجد محادثات بعد. اضغط + وابدأ بإضافة بريد صديق.')) + '</li>';
    return;
  }
  ul.innerHTML = list.map(it => {
    const p = person(it.other), c = it.chat;
    const ph = p && okPhoto(p.photo) ? p.photo : '';
    const lm = c && c.lastMessage;
    let prev = '<span class="tx">' + t('ابدأ المحادثة') + '</span>';
    if (lm) {
      let tk = '';
      if (lm.from === S.uid) {
        const r = c.reads && c.reads[it.other];
        tk = c._pending ? icon('pending') : (rrOn() && r && millis(r) >= millis(c.lastTs) ? icon('read') : icon('sent'));
      }
      prev = tk + '<span class="tx">' + esc(t(lm.text)) + '</span>';
    }
    const unread = (c && c.unread && c.unread[S.uid]) || 0;
    return '<li><button class="row" type="button" data-id="' + esc(it.id) + '" data-other="' + esc(it.other) + '" aria-current="' + (it.id === S.activeId) + '">'
      + '<span class="avatar' + (isOnline(p) ? ' on' : '') + (ph ? ' has-img' : '') + '" style="--c:' + personColor(it.other) + (ph ? ";--img:url('" + ph + "')" : '') + '">' + (ph ? '' : esc(initial(personName(it.other)))) + '</span>'
      + '<span class="mid"><span class="name">' + esc(personName(it.other)) + '</span><span class="prev">' + prev + '</span></span>'
      + '<span class="end"><span class="time">' + (c && c.lastTs ? listTime(millis(c.lastTs)) : '') + '</span>'
      + (unread ? '<span class="badge">' + unread + '</span>' : '') + '</span>'
      + '</button></li>';
  }).join('');
}

function renderThread(force) {
  const th = $('#thread'), em = $('#empty');
  if (!S.activeId) { th.hidden = true; em.hidden = false; return; }
  em.hidden = true; th.hidden = false;
  const o = S.activeOther, p = person(o);
  const av = $('#cAv');
  paintAv(av, personName(o), personColor(o), p && p.photo); av.classList.toggle('on', isOnline(p));
  $('#cName').textContent = personName(o);
  const st = $('#cSt');
  st.className = 'st';
  if (isOnline(p)) { st.textContent = t('متصل الآن'); st.classList.add('on'); }
  else st.textContent = (p && p.status) || '';

  const chat = S.chats.get(S.activeId);
  const theirRead = rrOn() && chat && chat.reads && chat.reads[o] ? millis(chat.reads[o]) : 0;
  const box = $('#msgs');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  const els = [];
  // نعيد استخدام عناصر الرسائل كما هي حتى لا يتوقف فيديو أو صوت أثناء تشغيله
  const put = (key, cls, sig, inner, tick) => {
    let el = NC.get(key);
    if (!el) { el = document.createElement('div'); NC.set(key, el); }
    if (el._sig !== sig) { el.innerHTML = inner(); el._sig = sig; }
    if (el.className !== cls) el.className = cls;
    const tk = el.querySelector('.tk');
    if (tk && tk._v !== tick) { tk.innerHTML = tick || ''; tk._v = tick; }
    els.push(el);
  };
  let prevFrom = null, lastDay = null;
  S.msgs.forEach(m => {
    const ts = millis(m.createdAt) || Date.now();
    const dk = new Date(ts).toDateString();
    if (dk !== lastDay) { const dl = dayLabel(ts); put('day:' + dk, 'day', dl, () => esc(dl)); lastDay = dk; prevFrom = null; }
    const mine = m.from === S.uid;
    const tick = mine ? (m.pending ? icon('pending') : (theirRead && theirRead >= ts ? icon('read') : icon('sent'))) : '';
    const cls = 'bubble ' + (mine ? 'me' : 'them') + (prevFrom !== m.from ? ' first' : '') + (m.type ? ' media' : '');
    const tm = hm(ts);
    put('m:' + m.id, cls, bodySig(m) + '|' + tm, () => bodyHtml(m) + '<div class="meta"><span>' + tm + '</span><span class="tk"></span></div>', tick);
    prevFrom = m.from;
  });
  S.uploads.filter(u => u.chatId === S.activeId).forEach(u => {
    const pct = Math.round(u.progress * 100);
    put('up:' + u.id, 'bubble me first media', 'up' + pct,
      () => '<div class="up-box"><span class="up-t">' + t('جارٍ إرسال الفيديو…') + ' ' + pct + '%</span><div class="up-bar"><i style="width:' + pct + '%"></i></div></div><div class="meta"><span class="tk"></span></div>',
      icon('pending'));
  });
  const n = box.children.length;
  let same = n <= els.length;
  for (let i = 0; same && i < n; i++) if (box.children[i] !== els[i]) same = false;
  if (same) { for (let i = n; i < els.length; i++) box.appendChild(els[i]); }
  else box.replaceChildren(...els);
  const keep = new Set(els);
  NC.forEach((v, k) => { if (!keep.has(v)) NC.delete(k); });
  if (near || force) box.scrollTop = box.scrollHeight;
  paintAudio();
}

/* ---------- محتوى الرسائل: نص / صورة / صوت / فيديو ---------- */
function bodySig(m) {
  if (m.type === 'image') return 'img:' + m.id;
  if (m.type === 'audio') return 'aud:' + m.id;
  if (m.type === 'video') return 'vid:' + m.id + ':' + (VID.has(m.id) ? 'r' : VIDLOAD.has(m.id) ? 'l' : 'p');
  return 't:' + m.text;
}
function bodyHtml(m) {
  if (m.type === 'image') {
    if (!okImg(m.data)) return '<div class="t">' + t('تعذر عرض الصورة.') + '</div>';
    const ar = m.w > 0 && m.h > 0 ? ' style="aspect-ratio:' + (+m.w) + '/' + (+m.h) + '"' : '';
    return '<img class="m-img" alt="' + t('صورة') + '" src="' + m.data + '"' + ar + '>';
  }
  if (m.type === 'audio') {
    if (!okAudio(m.data)) return '<div class="t">' + t('تعذر عرض التسجيل.') + '</div>';
    const d = Math.max(1, Math.round(+m.dur || 1));
    return '<div class="vm" data-mid="' + esc(m.id) + '" data-dur="' + d + '">'
      + '<button type="button" class="vm-play" aria-label="' + t('تشغيل أو إيقاف') + '">'
      + '<svg class="i-play" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.8l-10-6.5A1 1 0 0 0 8 5.5z"/></svg>'
      + '<svg class="i-pause" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      + '</button><div class="vm-bar"><i></i></div><span class="vm-t num">' + fmtDur(d) + '</span></div>';
  }
  if (m.type === 'video') {
    const ar = 'aspect-ratio:' + (m.w > 0 && m.h > 0 ? (+m.w) + '/' + (+m.h) : '16/9') + ';';
    const u = VID.get(m.id);
    if (u) return '<video class="m-vid" controls playsinline preload="metadata" src="' + u + '#t=0.1" style="' + ar + '"></video>';
    const info = (m.size ? fmtMB(+m.size) : '') + (m.dur ? ' · ' + fmtDur(+m.dur) : '');
    const loading = VIDLOAD.has(m.id);
    return '<button type="button" class="vid-ph" data-vid="' + esc(m.id) + '" style="' + ar + '"' + (loading ? ' disabled' : '') + '>'
      + (loading ? '<span class="spin"></span><span class="vid-info">' + t('جارٍ تحميل الفيديو…') + '</span>'
        : '<span class="play"><svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.8l-10-6.5A1 1 0 0 0 8 5.5z"/></svg></span><span class="vid-info">' + esc(info || t('فيديو')) + '</span>')
      + '</button>';
  }
  return '<div class="t">' + esc(m.text) + '</div>';
}

function updateTitle() {
  let n = 0;
  S.chats.forEach(c => { n += (c.unread && c.unread[S.uid]) || 0; });
  document.title = (n ? '(' + n + ') ' : '') + t('ونسة');
}

function openChat(id, other) {
  if (S.unsubMsgs) { S.unsubMsgs(); S.unsubMsgs = null; }
  S.activeId = id; S.activeOther = other; S.msgs = [];
  NC.clear(); $('#msgs').replaceChildren(); stopAudio(); cancelRec();
  ensurePerson(other);
  $('#app').classList.add('show-conv');
  renderList(); renderThread(true);
  S.unsubMsgs = onSnapshot(
    query(collection(db, 'chats', id, 'messages'), orderBy('createdAt', 'asc'), limitToLast(100)),
    snap => {
      if (S.activeId !== id) return;
      S.msgs = snap.docs.map(d => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: 'estimate' }) }));
      renderThread(); markRead();
    },
    err => { console.error(err); toast(t('تعذر تحميل الرسائل.')); }
  );
  markRead();
  if (wide()) setTimeout(() => $('#ta').focus(), 30);
}
function closeChat() {
  if (S.unsubMsgs) { S.unsubMsgs(); S.unsubMsgs = null; }
  S.activeId = null; S.activeOther = null; S.msgs = [];
  NC.clear(); $('#msgs').replaceChildren(); stopAudio(); cancelRec();
  $('#app').classList.remove('show-conv');
  renderList(); renderThread();
}

/** يصفّر عدّاد غير المقروء ويسجّل وقت القراءة (تظهر علامتا القراءة عند الطرف الآخر) */
function markRead() {
  const id = S.activeId;
  if (!id || document.hidden) return;
  const c = S.chats.get(id);
  if (!c) return;
  const unread = (c.unread && c.unread[S.uid]) || 0;
  if (unread <= 0) return;
  const upd = { ['unread.' + S.uid]: 0 };
  if (rrOn()) upd['reads.' + S.uid] = serverTimestamp();
  updateDoc(doc(db, 'chats', id), upd).catch(err => console.error(err));
}

/* إرسال رسالة: payload = {text} أو {type, data|chunks, ...}، و label نص يظهر في قائمة المحادثات */
function commitSend(id, other, payload, label, existing, msgRef) {
  const chatRef = doc(db, 'chats', id);
  msgRef = msgRef || doc(collection(chatRef, 'messages'));
  const batch = writeBatch(db);
  const last = { text: label.slice(0, 200), from: S.uid };
  batch.set(msgRef, { from: S.uid, text: '', ...payload, createdAt: serverTimestamp() });
  if (existing) {
    batch.update(chatRef, {
      lastMessage: last, lastTs: serverTimestamp(),
      ['unread.' + other]: increment(1),
      ...(rrOn() ? { ['reads.' + S.uid]: serverTimestamp() } : {})
    });
  } else {
    batch.set(chatRef, {
      members: [S.uid, other].sort(), createdAt: serverTimestamp(),
      lastMessage: last, lastTs: serverTimestamp(),
      unread: { [other]: 1, [S.uid]: 0 },
      reads: rrOn() ? { [S.uid]: serverTimestamp() } : {}
    });
  }
  return batch.commit();
}
async function deliver(id, other, payload, label, msgRef) {
  let existing = S.chats.has(id);
  if (!existing) {
    try { existing = (await getDoc(doc(db, 'chats', id))).exists(); } catch (e) { /* نجرّب الإنشاء */ }
  }
  try {
    await commitSend(id, other, payload, label, existing, msgRef);
  } catch (err) {
    if (!existing && err && err.code === 'permission-denied') {
      try { await commitSend(id, other, payload, label, true, msgRef); return; } catch (e2) { err = e2; }
    }
    console.error(err);
    toast(t('تعذر إرسال الرسالة. تحقق من الاتصال وقواعد Firestore.'));
    throw err;
  }
}
function send() {
  const ta = $('#ta'), text = ta.value.trim();
  if (!S.activeId || !text) return;
  const id = S.activeId, other = S.activeOther;
  ta.value = ''; autosize();
  deliver(id, other, { text }, text).catch(() => {});
}
function autosize() {
  const ta = $('#ta');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  const has = !!ta.value.trim();
  $('#sendBtn').hidden = !has;
  $('#micBtn').hidden = has;
}

/* ---------- الصور: تصغير وضغط داخل المتصفح ثم تخزين مباشر في الرسالة ---------- */
async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* نجرّب Image */ }
  }
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(file), im = new Image();
    im.onload = () => { URL.revokeObjectURL(u); res(im); };
    im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('bad image')); };
    im.src = u;
  });
}
function drawScaled(bmp, max, square) {
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height, dw, dh;
  if (square) { const m = Math.min(sw, sh); sx = (sw - m) / 2; sy = (sh - m) / 2; sw = m; sh = m; dw = dh = max; }
  else { const k = Math.min(1, max / Math.max(sw, sh)); dw = Math.max(1, Math.round(sw * k)); dh = Math.max(1, Math.round(sh * k)); }
  const cv = document.createElement('canvas'); cv.width = dw; cv.height = dh;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, dw, dh);
  cx.drawImage(bmp, sx, sy, sw, sh, 0, 0, dw, dh);
  return cv;
}
async function imageToDataUrl(file, o) {
  const bmp = await loadBitmap(file);
  try {
    for (const m of o.max) for (const q of o.qualities) {
      const cv = drawScaled(bmp, m, o.square);
      const url = cv.toDataURL('image/jpeg', q);
      if (url.length <= o.limit) return { url, w: cv.width, h: cv.height };
    }
  } finally { if (bmp.close) bmp.close(); }
  throw new Error('image too large');
}
async function sendImage(file) {
  const id = S.activeId, other = S.activeOther;
  try {
    const r = await imageToDataUrl(file, { max: [1280, 1000, 800, 600], qualities: [0.82, 0.7, 0.58], limit: 650000 });
    deliver(id, other, { type: 'image', data: r.url, w: r.w, h: r.h }, '📷 صورة').catch(() => {});
  } catch (err) {
    console.error(err);
    toast(t('تعذر إرسال هذه الصورة. جرّب صورة أخرى.'));
  }
}

/* ---------- الفيديو: يُقسَّم إلى قطع داخل Firestore (بدون Storage ولا فوترة) ---------- */
function blobToB64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = () => rej(fr.error || new Error('read failed'));
    fr.readAsDataURL(blob);
  });
}
function videoMeta(file) {
  return new Promise(res => {
    const v = document.createElement('video'), u = URL.createObjectURL(file);
    const done = o => { URL.revokeObjectURL(u); res(o); };
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => done({ dur: isFinite(v.duration) ? Math.round(v.duration) : 0, w: v.videoWidth, h: v.videoHeight });
    v.onerror = () => done({});
    setTimeout(() => done({}), 4000);
    v.src = u;
  });
}
async function sendVideo(file) {
  if (file.size > MAX_VIDEO) {
    toast(t('حجم الفيديو ') + fmtMB(file.size) + t('. الحد الأقصى ') + fmtMB(MAX_VIDEO) + t('، أرسل مقطعاً أقصر.'));
    return;
  }
  const id = S.activeId, other = S.activeOther;
  const up = { id: Math.random().toString(36).slice(2), chatId: id, progress: 0 };
  S.uploads.push(up); renderThread(true);
  try {
    const meta = await videoMeta(file);
    const mime = /^video\/[a-z0-9.+-]+$/i.test(file.type) ? file.type : 'video/mp4';
    const b64 = await blobToB64(file);
    const n = Math.ceil(b64.length / CHUNK);
    const msgRef = doc(collection(doc(db, 'chats', id), 'messages'));
    for (let i = 0; i < n; i += 4) {
      const batch = writeBatch(db);
      for (let k = i; k < Math.min(n, i + 4); k++) {
        batch.set(doc(db, 'chats', id, 'messages', msgRef.id, 'chunks', String(k).padStart(3, '0')), { d: b64.slice(k * CHUNK, (k + 1) * CHUNK) });
      }
      await batch.commit();
      up.progress = Math.min(n, i + 4) / n * 0.97;
      if (S.activeId === id) renderThread();
    }
    VID.set(msgRef.id, URL.createObjectURL(file)); // المرسل يشاهده فوراً دون إعادة تحميل
    const payload = { type: 'video', chunks: n, mime, size: file.size };
    if (meta.dur > 0) payload.dur = meta.dur;
    if (meta.w > 0 && meta.h > 0) { payload.w = meta.w; payload.h = meta.h; }
    await deliver(id, other, payload, '🎥 فيديو', msgRef);
  } catch (err) {
    console.error(err);
    toast(t('تعذر إرسال الفيديو. تحقق من الاتصال وقواعد Firestore.'));
  } finally {
    S.uploads = S.uploads.filter(u => u !== up);
    if (S.activeId === id) renderThread(true);
  }
}
async function loadVideo(mid) {
  if (VID.has(mid) || VIDLOAD.has(mid)) return;
  const m = S.msgs.find(x => x.id === mid), cid = S.activeId;
  if (!m || !cid) return;
  VIDLOAD.add(mid); renderThread();
  try {
    const snap = await getDocs(collection(db, 'chats', cid, 'messages', mid, 'chunks'));
    if (snap.size < (+m.chunks || 1)) throw new Error('missing chunks');
    const b64 = snap.docs.sort((a, b) => (a.id < b.id ? -1 : 1)).map(d => d.data().d).join('');
    const mime = /^video\/[a-z0-9.+-]+$/i.test(m.mime || '') ? m.mime : 'video/mp4';
    const blob = await (await fetch('data:' + mime + ';base64,' + b64)).blob();
    VID.set(mid, URL.createObjectURL(blob));
  } catch (err) {
    console.error(err);
    toast(t('تعذر تحميل الفيديو. حاول مرة ثانية.'));
  } finally {
    VIDLOAD.delete(mid);
    if (S.activeId === cid) renderThread();
  }
}

/* ---------- الرسائل الصوتية ---------- */
let REC = null;
const REC_MAX = 120;
async function startRec() {
  if (!S.activeId || REC) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast(t('تسجيل الصوت يحتاج متصفحاً حديثاً ورابطاً يبدأ بـ https.'));
    return;
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { toast(t('اسمح للمتصفح باستخدام الميكروفون لتسجيل رسالة صوتية.')); return; }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  let rec;
  try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : { audioBitsPerSecond: 24000 }); }
  catch (e) { try { rec = new MediaRecorder(stream); } catch (e2) { stream.getTracks().forEach(t => t.stop()); toast(t('تعذر بدء التسجيل على هذا الجهاز.')); return; } }
  const R = { rec, parts: [], t0: Date.now(), chat: S.activeId, other: S.activeOther, send: false, timer: null };
  REC = R;
  rec.ondataavailable = e => { if (e.data && e.data.size) R.parts.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(R.timer);
    $('#composer').classList.remove('recording');
    if (REC === R) REC = null;
    if (!R.send) return;
    const dur = (Date.now() - R.t0) / 1000;
    if (dur < 1) { toast(t('التسجيل قصير جداً.')); return; }
    try {
      const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
      const b64 = await blobToB64(new Blob(R.parts, { type }));
      const data = 'data:' + type + ';base64,' + b64;
      if (data.length > 720000) { toast(t('التسجيل طويل جداً. سجّل رسالة أقصر.')); return; }
      deliver(R.chat, R.other, { type: 'audio', data, dur: Math.round(dur) }, '🎤 رسالة صوتية').catch(() => {});
    } catch (err) { console.error(err); toast(t('تعذر إرسال التسجيل.')); }
  };
  rec.start();
  $('#composer').classList.add('recording');
  const tick = () => {
    const sec = (Date.now() - R.t0) / 1000;
    $('#recTime').textContent = fmtDur(sec);
    if (sec >= REC_MAX) { R.send = true; if (rec.state !== 'inactive') rec.stop(); }
  };
  tick(); R.timer = setInterval(tick, 250);
}
function finishRec(send) {
  if (!REC) return;
  REC.send = send;
  if (REC.rec.state !== 'inactive') REC.rec.stop();
}
function cancelRec() { finishRec(false); }

let AU = null; // التسجيل الجاري تشغيله: {mid, el}
function paintAudio() {
  $$('#msgs .vm').forEach(v => {
    const on = !!(AU && v.dataset.mid === AU.mid);
    const playing = on && !AU.el.paused;
    const total = on && isFinite(AU.el.duration) && AU.el.duration > 0 ? AU.el.duration : +v.dataset.dur;
    v.classList.toggle('playing', playing);
    v.style.setProperty('--p', on ? Math.min(100, AU.el.currentTime / total * 100) + '%' : '0%');
    $('.vm-t', v).textContent = fmtDur(playing ? AU.el.currentTime : +v.dataset.dur);
  });
}
function stopAudio() {
  if (!AU) return;
  AU.el.pause(); AU = null; paintAudio();
}
function toggleAudio(mid) {
  if (AU && AU.mid === mid) { if (AU.el.paused) AU.el.play().catch(() => {}); else AU.el.pause(); return; }
  stopAudio();
  const m = S.msgs.find(x => x.id === mid);
  if (!m || !okAudio(m.data)) return;
  const el = new Audio(m.data);
  AU = { mid, el };
  ['timeupdate', 'play', 'pause'].forEach(ev => el.addEventListener(ev, paintAudio));
  el.addEventListener('ended', () => { if (AU && AU.el === el) AU = null; paintAudio(); });
  el.play().catch(() => { toast(t('تعذر تشغيل هذا التسجيل على جهازك.')); if (AU && AU.el === el) AU = null; paintAudio(); });
}

/* أزرار الإرفاق والتسجيل ونقرات الوسائط */
$('#attBtn').addEventListener('click', () => { if (S.activeId) $('#fileIn').click(); });
$('#fileIn').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = '';
  for (const f of files) {
    if (!S.activeId) break;
    if (f.type.startsWith('image/')) await sendImage(f);
    else if (f.type.startsWith('video/')) await sendVideo(f);
    else toast(t('يمكنك إرسال الصور والفيديوهات فقط.'));
  }
});
$('#micBtn').addEventListener('click', startRec);
$('#recCancel').addEventListener('click', () => finishRec(false));
$('#recSend').addEventListener('click', () => finishRec(true));
$('#msgs').addEventListener('click', e => {
  const pl = e.target.closest('.vm-play');
  if (pl) { toggleAudio(pl.closest('.vm').dataset.mid); return; }
  const ph = e.target.closest('.vid-ph');
  if (ph) { loadVideo(ph.dataset.vid); return; }
  const im = e.target.closest('.m-img');
  if (im) { $('#lbImg').src = im.src; openOv($('#ovLb'), '[data-close]'); }
});
$('#ta').addEventListener('input', autosize);
$('#ta').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch() && P.enter) { e.preventDefault(); send(); }
});
$('#composer').addEventListener('submit', e => { e.preventDefault(); send(); if (!isTouch()) $('#ta').focus(); });
$('#chats').addEventListener('click', e => {
  const b = e.target.closest('.row');
  if (b) openChat(b.dataset.id, b.dataset.other);
});
$('#backBtn').addEventListener('click', closeChat);
$('#q').addEventListener('input', renderList);

/* الحضور: آخر ظهور يُحدَّث كل دقيقة والتبويب ظاهر */
function beat() {
  if (document.hidden || !S.uid) return;
  updateDoc(doc(db, 'users', S.uid), { lastSeen: serverTimestamp() }).catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.uid) { beat(); markRead(); } });

function startApp() {
  view('app');
  renderMe(); renderStories();
  S.chats = new Map(); S.autoOpened = false;
  $('#q').value = '';
  beat();
  S.hb = setInterval(beat, 60000);
  S.clock = setInterval(() => { renderList(); renderThread(); mergeStories(); }, 30000);
  S.unsubChats = onSnapshot(
    query(collection(db, 'chats'), where('members', 'array-contains', S.uid)),
    snap => {
      const m = new Map();
      const prevU = new Map([...S.chats].map(([k, c]) => [k, (c.unread && c.unread[S.uid]) || 0]));
      let ring = false;
      snap.forEach(d => {
        const c = { id: d.id, _pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: 'estimate' }) };
        m.set(d.id, c);
        ensurePerson(otherOf(c));
        const u = (c.unread && c.unread[S.uid]) || 0;
        if (S.chatsReady && u > (prevU.get(d.id) || 0) && !(d.id === S.activeId && !document.hidden)) ring = true;
      });
      S.chats = m;
      S.chatsReady = true;
      if (ring) beep();
      syncStories();
      if (S.draft && m.has(S.draft.id)) S.draft = null;
      renderList(); if (S.activeId) renderThread();
      markRead(); updateTitle();
      if (!S.autoOpened) {
        S.autoOpened = true;
        if (wide() && !S.activeId) { const f = items()[0]; if (f) openChat(f.id, f.other); }
      }
    },
    err => { console.error(err); toast(t('تعذر تحميل المحادثات. تحقق من قواعد Firestore.')); }
  );
}

function teardown() {
  if (S.unsubChats) { S.unsubChats(); S.unsubChats = null; }
  if (S.unsubMsgs) { S.unsubMsgs(); S.unsubMsgs = null; }
  S.peopleUnsubs.forEach(u => u()); S.peopleUnsubs = new Map(); S.people = new Map();
  clearInterval(S.hb); clearInterval(S.clock);
  S.stUnsubs.forEach(u => u()); S.stUnsubs = []; S.stKey = ''; S.stDocs = new Map(); S.stories = new Map(); S.chatsReady = false;
  clearTimeout(V.timer); $('#stories').innerHTML = '';
  S.chats = new Map(); S.msgs = []; S.activeId = null; S.activeOther = null; S.draft = null;
  NC.clear(); stopAudio(); cancelRec();
  $('#app').classList.remove('show-conv');
  document.title = 'ونسة';
}

/* ---------- dialogs ---------- */
let lastFocus = null;
function openOv(el, focusSel) {
  lastFocus = document.activeElement;
  el.hidden = false;
  setTimeout(() => { const f = $(focusSel, el); if (f) f.focus(); }, 30);
}
function closeOv(el) {
  el.hidden = true;
  if (el.id === 'ovSet') resetLogout();
  if (el.id === 'ovSt') { clearTimeout(V.timer); renderStories(); }
  if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignore */ } }
}
$$('.overlay').forEach(ov => {
  ov.addEventListener('mousedown', e => { if (e.target === ov) closeOv(ov); });
  $$('[data-close]', ov).forEach(b => b.addEventListener('click', () => closeOv(ov)));
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $$('.overlay').forEach(ov => { if (!ov.hidden) closeOv(ov); });
});

/* محادثة جديدة: نبحث عن البريد في فهرس emails */
function openNew() {
  $('#nEmail').value = ''; $('#eN').textContent = ''; $('#inviteBtn').hidden = true;
  openOv($('#ovNew'), '#nEmail');
}
$('#newBtn').addEventListener('click', openNew);
$('#newBtn2').addEventListener('click', openNew);
$('#newForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = normEmail($('#nEmail').value);
  $('#inviteBtn').hidden = true;
  if (!validEmail(email)) { $('#eN').textContent = t('اكتب بريداً إلكترونياً صحيحاً، مثل name@gmail.com.'); return; }
  if (email === S.email) { $('#eN').textContent = t('هذا بريدك أنت. أدخل بريد شخص آخر.'); return; }
  const btn = $('#newForm button[type=submit]');
  busy(btn, true); $('#eN').textContent = '';
  try {
    const snap = await getDoc(doc(db, 'emails', email));
    if (!snap.exists()) {
      $('#eN').textContent = t('هذا البريد غير مسجّل في ونسة بعد. ادعُ صاحبه ليدخل بحساب Google.');
      $('#inviteBtn').hidden = false;
      return;
    }
    const other = snap.data().uid;
    const id = chatIdFor(S.uid, other);
    ensurePerson(other);
    if (!S.chats.has(id)) S.draft = { id, other };
    closeOv($('#ovNew'));
    openChat(id, other);
    if (!wide()) setTimeout(() => $('#ta').focus(), 80);
  } catch (err) {
    console.error(err);
    $('#eN').textContent = t('تعذر البحث عن البريد. تحقق من الاتصال وقواعد Firestore.');
  } finally { busy(btn, false); }
});
$('#inviteBtn').addEventListener('click', async () => {
  const text = t('سجّل في ونسة وابدأ الونسة معي: ') + location.origin;
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast(t('تم نسخ رابط الدعوة.')); }
  } catch (e) { /* تجاهل إلغاء المشاركة */ }
});

/* الإعدادات */
$('#meBtn').addEventListener('click', () => {
  paintAv($('#sAv'), S.me.name, S.me.color, S.me.photo);
  $('#avDel').hidden = !okPhoto(S.me.photo);
  $('#sEmail').textContent = S.email;
  $('#sName').value = S.me.name; $('#sStatus').value = S.me.status || ''; $('#eS').textContent = '';
  resetLogout();
  openOv($('#ovSet'), '#sName');
});
$('#setForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#sName').value.trim();
  if (name.length < 2) { $('#eS').textContent = t('اكتب اسماً من حرفين على الأقل.'); return; }
  const btn = $('#setForm button[type=submit]');
  busy(btn, true);
  try {
    const status = $('#sStatus').value.trim();
    await updateDoc(doc(db, 'users', S.uid), { name, status });
    S.me = { ...S.me, name, status };
    renderMe(); closeOv($('#ovSet'));
  } catch (err) {
    console.error(err);
    $('#eS').textContent = t('تعذر حفظ التغييرات. حاول مرة ثانية.');
  } finally { busy(btn, false); }
});
async function setPhoto(photo) {
  await updateDoc(doc(db, 'users', S.uid), { photo });
  S.me = { ...S.me, photo };
  renderMe();
  paintAv($('#sAv'), S.me.name, S.me.color, photo);
  $('#avDel').hidden = !okPhoto(photo);
}
const pickAvatar = () => $('#avIn').click();
$('#sAvBtn').addEventListener('click', pickAvatar);
$('#sAvPick').addEventListener('click', pickAvatar);
$('#avIn').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (!f.type.startsWith('image/')) { $('#eS').textContent = t('اختر ملف صورة.'); return; }
  $('#eS').textContent = '';
  try {
    const r = await imageToDataUrl(f, { max: [256, 192, 128], qualities: [0.82, 0.7, 0.55], square: true, limit: 60000 });
    await setPhoto(r.url);
  } catch (err) {
    console.error(err);
    $('#eS').textContent = t('تعذر حفظ الصورة. جرّب صورة أخرى وتأكد من تحديث قواعد Firestore.');
  }
});
$('#avDel').addEventListener('click', async () => {
  try { await setPhoto(''); } catch (err) { console.error(err); $('#eS').textContent = t('تعذر حذف الصورة.'); }
});
let logoutArmed = false;
function resetLogout() { logoutArmed = false; $('#logoutBtn').textContent = t('تسجيل الخروج'); }
$('#logoutBtn').addEventListener('click', async () => {
  if (!logoutArmed) { logoutArmed = true; $('#logoutBtn').textContent = t('اضغط مرة ثانية لتأكيد الخروج'); return; }
  $('#ovSet').hidden = true; resetLogout();
  try { await signOut(auth); } catch (err) { console.error(err); toast(t('تعذر تسجيل الخروج.')); }
});

/* =====================================================================
   3) الصوت والإعدادات والخلفيات
   ===================================================================== */
let actx = null;
document.addEventListener('pointerdown', () => {
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { /* ignore */ }
}, { once: true });
function beep() {
  if (!P.sound || !actx) return;
  try {
    const o = actx.createOscillator(), g = actx.createGain(), now = actx.currentTime;
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.14, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    o.connect(g); g.connect(actx.destination);
    o.start(now); o.stop(now + 0.3);
  } catch (e) { /* ignore */ }
}

/* ---- خلفيات المحادثة ---- */
const WP_PRESETS = [
  { id: 'dots', n: 'نقاط' }, { id: 'plain', n: 'سادة' }, { id: 'grid', n: 'شبكة' }, { id: 'diag', n: 'خطوط' },
  { id: 'blue', n: 'أزرق', c: '#2F66B3' }, { id: 'green', n: 'أخضر', c: '#1F7A6B' }, { id: 'purple', n: 'بنفسجي', c: '#5B4BB5' },
  { id: 'rose', n: 'وردي', c: '#A8327A' }, { id: 'orange', n: 'برتقالي', c: '#B8432F' }, { id: 'amber', n: 'ذهبي', c: '#8A6A00' }
];
const WP_IMG = 'wonasa.wpimg';
const okWp = p => typeof p === 'string' && p.length < 900000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p);
const ink = pc => 'color-mix(in srgb,var(--ink) ' + pc + '%,transparent)';
function wpCss(id) {
  const k = WP_PRESETS.find(x => x.id === id);
  if (id === 'custom') {
    let img = ''; try { img = localStorage.getItem(WP_IMG) || ''; } catch (e) { /* ignore */ }
    if (!okWp(img)) return wpCss('dots');
    const ov = 'linear-gradient(color-mix(in srgb,var(--chat) 28%,transparent),color-mix(in srgb,var(--chat) 28%,transparent))';
    return ['background-image:' + ov + ",url('" + img + "')", 'background-size:cover', 'background-position:center'];
  }
  if (id === 'plain') return ['background-image:none'];
  if (id === 'grid') return ['background-image:linear-gradient(' + ink(7) + ' 1px,transparent 1px),linear-gradient(90deg,' + ink(7) + ' 1px,transparent 1px)', 'background-size:28px 28px'];
  if (id === 'diag') return ['background-image:repeating-linear-gradient(45deg,' + ink(6) + ' 0 2px,transparent 2px 16px)', 'background-size:auto'];
  if (k && k.c) return ['background-image:linear-gradient(160deg,color-mix(in srgb,' + k.c + ' 30%,var(--chat)),color-mix(in srgb,' + k.c + ' 6%,var(--chat)))', 'background-size:auto'];
  return ['background-image:radial-gradient(' + ink(8) + ' 1px,transparent 1.3px)', 'background-size:24px 24px'];
}
function paintWpGrid() {
  const list = WP_PRESETS.map(x => ({ id: x.id, n: x.n }));
  let has = false; try { has = !!localStorage.getItem(WP_IMG); } catch (e) { /* ignore */ }
  if (has) list.push({ id: 'custom', n: 'صورتي' });
  $('#wpGrid').innerHTML = list.map(x =>
    '<button type="button" class="wp-opt" data-w="' + x.id + '" style="' + wpCss(x.id).join(';') + '" aria-pressed="' + (P.wp === x.id) + '"><span>' + esc(t(x.n)) + '</span></button>').join('');
}
function openWp() {
  if (!$('#ovPrefs').hidden) $('#ovPrefs').hidden = true;
  paintWpGrid(); $('#eWp').textContent = '';
  openOv($('#ovWp'), '[data-close]');
}
$('#wpBtn').addEventListener('click', openWp);
$('#openWp').addEventListener('click', openWp);
$('#wpGrid').addEventListener('click', e => {
  const b = e.target.closest('.wp-opt'); if (!b) return;
  P.wp = b.dataset.w; savePrefs(); applyPrefs(); paintWpGrid();
});
$('#wpPick').addEventListener('click', () => $('#wpIn').click());
$('#wpIn').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (!f.type.startsWith('image/')) { $('#eWp').textContent = t('اختر ملف صورة.'); return; }
  $('#eWp').textContent = '';
  try {
    const r = await imageToDataUrl(f, { max: [1100, 900, 700], qualities: [0.6, 0.5, 0.4], limit: 600000 });
    localStorage.setItem(WP_IMG, r.url);
    P.wp = 'custom'; savePrefs(); applyPrefs(); paintWpGrid();
  } catch (err) {
    console.error(err);
    $('#eWp').textContent = t('تعذر استخدام هذه الصورة. جرّب صورة أخرى.');
  }
});

/* ---- نافذة الإعدادات ---- */
const BUBBLES = [['def', '#34439A'], ['green', '#1F7A6B'], ['purple', '#5B4BB5'], ['rose', '#A8327A'], ['orange', '#B8432F'], ['blue', '#2F66B3'], ['amber', '#8A6A00']];
$('#bubbleSw').innerHTML = BUBBLES.map(([id, c]) =>
  '<button type="button" class="sw" style="--c:' + c + '" data-b="' + id + '" aria-label="' + t('لون') + '" aria-pressed="false"></button>').join('');
function paintPrefsUi() {
  const pr = (sel, val) => $$(sel + ' button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === val)));
  pr('#segTheme', P.theme); pr('#segFont', P.font); pr('#segLang', P.lang);
  $$('#bubbleSw .sw').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.b === P.bubble)));
  $('#swSound').checked = !!P.sound; $('#swEnter').checked = !!P.enter;
  $('#swHide').checked = !!(S.me && S.me.hideOnline);
  $('#swRead').checked = rrOn();
}
function seg(sel, fn) {
  $(sel).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    fn(b.dataset.v); savePrefs(); paintPrefsUi();
  });
}
seg('#segTheme', v => { P.theme = v; applyPrefs(); });
seg('#segFont', v => { P.font = v; applyPrefs(); });
seg('#segLang', v => {
  if (P.lang === v) return;
  P.lang = v; applyPrefs();
  NC.clear(); resetLogout();
  if (S.uid) { renderMe(); renderList(); renderThread(true); renderStories(); updateTitle(); }
});
$('#bubbleSw').addEventListener('click', e => {
  const b = e.target.closest('.sw'); if (!b) return;
  P.bubble = b.dataset.b; savePrefs(); applyPrefs(); paintPrefsUi();
});
$('#swSound').addEventListener('change', e => { P.sound = e.target.checked; savePrefs(); if (P.sound) beep(); });
$('#swEnter').addEventListener('change', e => { P.enter = e.target.checked; savePrefs(); });
async function setPrivacy(field, val, box) {
  try {
    await updateDoc(doc(db, 'users', S.uid), { [field]: val });
    S.me = { ...S.me, [field]: val };
    renderThread();
  } catch (err) {
    console.error(err);
    box.checked = !box.checked;
    toast(t('تعذر حفظ التغييرات. حاول مرة ثانية.'));
  }
}
$('#swHide').addEventListener('change', e => setPrivacy('hideOnline', e.target.checked, e.target));
$('#swRead').addEventListener('change', e => setPrivacy('readReceipts', e.target.checked, e.target));
$('#gearBtn').addEventListener('click', () => { paintPrefsUi(); openOv($('#ovPrefs'), '[data-close]'); });
$('#openProfile').addEventListener('click', () => { closeOv($('#ovPrefs')); $('#meBtn').click(); });

/* =====================================================================
   4) القصص (تختفي بعد 24 ساعة)
   ===================================================================== */
const STORY_MS = 864e5;
const ST_BG = ['#1F7A6B', '#5B4BB5', '#A8327A', '#B8432F', '#2F66B3', '#8A6A00', '#1A2354'];
const okStoryImg = p => typeof p === 'string' && p.length < 520000 && IMG_RE.test(p);
const okBg = c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
let SEEN = {};
try { SEEN = JSON.parse(localStorage.getItem('wonasa.seen') || '{}'); } catch (e) { SEEN = {}; }
const markSeen = id => { if (SEEN[id]) return; SEEN[id] = 1; try { localStorage.setItem('wonasa.seen', JSON.stringify(SEEN)); } catch (e) { /* ignore */ } };

function syncStories() {
  const uids = [...new Set([S.uid, ...[...S.chats.values()].map(otherOf)])].filter(Boolean).sort();
  const key = uids.join(',');
  if (key === S.stKey) return;
  S.stKey = key;
  S.stUnsubs.forEach(u => u()); S.stUnsubs = []; S.stDocs = new Map();
  for (let i = 0; i < uids.length; i += 30) {
    const chunk = uids.slice(i, i + 30), k = i;
    S.stUnsubs.push(onSnapshot(query(collection(db, 'stories'), where('uid', 'in', chunk)), snap => {
      S.stDocs.set(k, snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })));
      mergeStories();
    }, err => console.error(err)));
  }
}
function mergeStories() {
  if (!S.uid) return;
  const now = Date.now(), m = new Map(), ids = new Set();
  S.stDocs.forEach(arr => arr.forEach(s => {
    const ts = millis(s.createdAt) || now;
    if (now - ts >= STORY_MS) {
      if (s.uid === S.uid && !S.stDel.has(s.id)) { S.stDel.add(s.id); deleteDoc(doc(db, 'stories', s.id)).catch(() => {}); }
      return;
    }
    s._ts = ts; ids.add(s.id);
    if (!m.has(s.uid)) m.set(s.uid, []);
    m.get(s.uid).push(s);
  }));
  m.forEach(a => a.sort((x, y) => x._ts - y._ts));
  S.stories = m;
  let dirty = false;
  Object.keys(SEEN).forEach(k => { if (!ids.has(k)) { delete SEEN[k]; dirty = true; } });
  if (dirty) { try { localStorage.setItem('wonasa.seen', JSON.stringify(SEEN)); } catch (e) { /* ignore */ } }
  renderStories();
}
function avHtml(uid, size) {
  const p = uid === S.uid ? S.me : person(uid);
  const name = p ? p.name : '', color = (p && p.color) || COLORS[4], ph = p && okPhoto(p.photo) ? p.photo : '';
  return '<span class="avatar' + (ph ? ' has-img' : '') + '" style="--s:' + size + 'px;--c:' + color + (ph ? ";--img:url('" + ph + "')" : '') + '">' + (ph ? '' : esc(initial(name))) + '</span>';
}
function storyOrder() {
  const others = [...S.stories.entries()].filter(([u]) => u !== S.uid)
    .map(([u, a]) => ({ u, unseen: a.some(s => !SEEN[s.id]), last: a[a.length - 1]._ts }))
    .sort((x, y) => (y.unseen - x.unseen) || (y.last - x.last));
  return { mine: S.stories.has(S.uid), others };
}
function renderStories() {
  if (!S.uid || !S.me) return;
  const { mine, others } = storyOrder();
  const myRing = mine ? (S.stories.get(S.uid).some(s => !SEEN[s.id]) ? 'unseen' : 'seen') : 'none';
  let h = '<div class="st-item"><button class="st-open" type="button" data-u="' + esc(S.uid) + '"><span class="st-ring ' + myRing + '">' + avHtml(S.uid, 52) + '</span><span class="st-name">' + esc(t('قصتي')) + '</span></button>'
    + '<button class="st-plus" type="button" data-add="1" aria-label="' + esc(t('قصة جديدة')) + '">+</button></div>';
  others.forEach(o => {
    h += '<div class="st-item"><button class="st-open" type="button" data-u="' + esc(o.u) + '"><span class="st-ring ' + (o.unseen ? 'unseen' : 'seen') + '">' + avHtml(o.u, 52) + '</span><span class="st-name">' + esc(personName(o.u)) + '</span></button></div>';
  });
  $('#stories').innerHTML = h;
}
$('#stories').addEventListener('click', e => {
  if (e.target.closest('.st-plus')) { openStoryCreate(); return; }
  const b = e.target.closest('.st-open'); if (!b) return;
  if (b.dataset.u === S.uid && !S.stories.has(S.uid)) openStoryCreate(); else openStories(b.dataset.u);
});

/* ---- العارض ---- */
const V = { queue: [], qi: 0, list: [], si: 0, timer: null };
function openStories(uid) {
  const { mine, others } = storyOrder();
  V.queue = [...(mine ? [S.uid] : []), ...others.map(o => o.u)];
  V.qi = Math.max(0, V.queue.indexOf(uid));
  V.list = S.stories.get(V.queue[V.qi]) || [];
  const k = V.list.findIndex(s => !SEEN[s.id]);
  openOv($('#ovSt'), '[data-close]');
  showStory(k < 0 ? 0 : k);
}
function showStory(si) {
  clearTimeout(V.timer);
  if (si < 0) {
    if (V.qi > 0) { V.qi--; V.list = S.stories.get(V.queue[V.qi]) || []; si = V.list.length - 1; } else si = 0;
  }
  if (si >= V.list.length) {
    if (V.qi + 1 < V.queue.length) {
      V.qi++; V.list = S.stories.get(V.queue[V.qi]) || [];
      const k = V.list.findIndex(s => !SEEN[s.id]); si = k < 0 ? 0 : k;
    } else { closeOv($('#ovSt')); return; }
  }
  if (!V.list.length) { closeOv($('#ovSt')); return; }
  V.si = si;
  const s = V.list[si], mine = s.uid === S.uid;
  markSeen(s.id);
  const dur = s.kind === 'text' ? Math.min(12, 5 + String(s.text || '').length / 30) : 7;
  $('#stBars').innerHTML = V.list.map((_, i) => '<i class="' + (i < si ? 'done' : i === si ? 'cur' : '') + '" style="--d:' + dur + 's"><b></b></i>').join('');
  const p = mine ? S.me : person(s.uid);
  paintAv($('#stAv'), p ? p.name : '', (p && p.color) || COLORS[4], p && p.photo);
  $('#stName').textContent = mine ? t('قصتي') : personName(s.uid);
  $('#stTime').textContent = hm(s._ts);
  $('#stDel').hidden = !mine;
  let body;
  if (s.kind === 'text') {
    body = '<div class="st-text" style="background:' + (okBg(s.bg) ? s.bg : ST_BG[0]) + '">' + esc(s.text || '') + '</div>';
  } else if (okStoryImg(s.data)) {
    body = '<img alt="' + esc(t('صورة')) + '" src="' + s.data + '">' + (s.caption ? '<div class="st-cap">' + esc(s.caption) + '</div>' : '');
  } else body = '<div class="st-text">' + esc(t('تعذر عرض الصورة.')) + '</div>';
  $('#stBody').innerHTML = body;
  V.timer = setTimeout(() => showStory(si + 1), dur * 1000);
}
$('#stNextB').addEventListener('click', () => showStory(V.si + 1));
$('#stPrevB').addEventListener('click', () => showStory(V.si - 1));
$('#stDel').addEventListener('click', async () => {
  const s = V.list[V.si]; if (!s) return;
  clearTimeout(V.timer);
  if (!confirm(t('حذف هذه القصة؟'))) { showStory(V.si); return; }
  try {
    await deleteDoc(doc(db, 'stories', s.id));
    V.list = V.list.filter(x => x.id !== s.id);
    showStory(Math.min(V.si, V.list.length));
  } catch (err) { console.error(err); toast(t('تعذر حذف القصة.')); showStory(V.si); }
});
document.addEventListener('keydown', e => {
  if ($('#ovSt').hidden) return;
  const next = document.documentElement.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  if (e.key === next) showStory(V.si + 1);
  else if (e.key === (next === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft')) showStory(V.si - 1);
});

/* ---- إنشاء قصة ---- */
const SC = { mode: 'image', bg: ST_BG[0], img: '' };
$('#stSw').innerHTML = ST_BG.map(c => '<button type="button" class="sw" style="--c:' + c + '" data-c="' + c + '" aria-label="' + t('لون') + '" aria-pressed="false"></button>').join('');
function paintSc() {
  const img = SC.mode === 'image';
  $$('#stMode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === SC.mode)));
  $('#stImg').hidden = !(img && SC.img); if (img && SC.img) $('#stImg').src = SC.img;
  $('#stText').hidden = img;
  $('#stPick').hidden = !img; $('#stPick').textContent = t(SC.img ? 'تغيير الصورة' : 'اختر صورة');
  $('#stSw').hidden = img; $('#stCap').hidden = !img;
  if (img) $('#stPrev').style.removeProperty('--bgc'); else $('#stPrev').style.setProperty('--bgc', SC.bg);
  $$('#stSw .sw').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.c === SC.bg)));
}
function openStoryCreate() {
  SC.mode = 'image'; SC.img = ''; SC.bg = ST_BG[0];
  $('#stText').value = ''; $('#stCap').value = ''; $('#eSt').textContent = '';
  paintSc(); openOv($('#ovStC'), '#stPick');
}
$('#stMode').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; SC.mode = b.dataset.v; paintSc(); if (SC.mode === 'text') $('#stText').focus(); });
$('#stSw').addEventListener('click', e => { const b = e.target.closest('.sw'); if (!b) return; SC.bg = b.dataset.c; paintSc(); });
$('#stPick').addEventListener('click', () => $('#stFile').click());
$('#stFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (!f.type.startsWith('image/')) { $('#eSt').textContent = t('اختر ملف صورة.'); return; }
  $('#eSt').textContent = '';
  try {
    const r = await imageToDataUrl(f, { max: [1080, 900, 720], qualities: [0.8, 0.68, 0.55], limit: 380000 });
    SC.img = r.url; paintSc();
  } catch (err) { console.error(err); $('#eSt').textContent = t('تعذر استخدام هذه الصورة. جرّب صورة أخرى.'); }
});
$('#stForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#stForm button[type=submit]');
  let payload;
  if (SC.mode === 'image') {
    if (!SC.img) { $('#eSt').textContent = t('اختر صورة أولاً.'); return; }
    payload = { kind: 'image', data: SC.img, caption: $('#stCap').value.trim().slice(0, 100) };
  } else {
    const text = $('#stText').value.trim();
    if (!text) { $('#eSt').textContent = t('اكتب نص القصة أولاً.'); return; }
    payload = { kind: 'text', text, bg: SC.bg };
  }
  $('#eSt').textContent = ''; busy(btn, true);
  try {
    await setDoc(doc(collection(db, 'stories')), { uid: S.uid, ...payload, createdAt: serverTimestamp() });
    closeOv($('#ovStC')); toast(t('تم نشر قصتك. تختفي بعد 24 ساعة.'));
  } catch (err) {
    console.error(err);
    $('#eSt').textContent = t('تعذر نشر القصة. تأكد من نشر قواعد Firestore الجديدة.') + ' (' + ((err && err.code) || '') + ')';
  } finally { busy(btn, false); }
});

/* ---------- boot ---------- */
applyPrefs();
paintProfile();
if (!configured) view('setup');
else {
  try { bootAuth(); }
  catch (err) { console.error(err); view('auth'); go(1); $('#e1').textContent = t('تعذر تشغيل Firebase: ') + (err && err.message ? err.message : ''); }
}
