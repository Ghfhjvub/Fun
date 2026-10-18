// دوال مساعدة بلا اعتماد على Firebase.

export const COLORS = ['#B8432F', '#1F7A6B', '#5B4BB5', '#A8327A', '#2F66B3', '#8A6A00'];

const AR_DIGITS = /[٠-٩۰-۹]/g;

/** يحوّل الأرقام العربية والفارسية إلى لاتينية */
export const latin = s =>
  String(s).replace(AR_DIGITS, ch => {
    const n = ch.charCodeAt(0);
    return String(n >= 0x06F0 ? n - 0x06F0 : n - 0x0660);
  });

export const esc = s =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const pad = n => String(n).padStart(2, '0');
export const hm = ts => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
export const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

function fmtDate(ts, opts) {
  try { return new Intl.DateTimeFormat('ar-u-nu-latn', opts).format(ts); }
  catch (e) { return new Date(ts).toLocaleDateString(); }
}
export const dayLabel = ts =>
  sameDay(ts, Date.now()) ? 'اليوم' :
  sameDay(ts, Date.now() - 864e5) ? 'أمس' :
  fmtDate(ts, { weekday: 'long', day: 'numeric', month: 'long' });
export const listTime = ts =>
  sameDay(ts, Date.now()) ? hm(ts) :
  sameDay(ts, Date.now() - 864e5) ? 'أمس' :
  fmtDate(ts, { day: 'numeric', month: 'numeric' });
export const seenLabel = ts =>
  'آخر ظهور ' + (sameDay(ts, Date.now()) ? 'اليوم ' : sameDay(ts, Date.now() - 864e5) ? 'أمس ' : '') + hm(ts);

export const initial = n => {
  const ch = [...String(n || '').trim()][0];
  return ch && /[\p{L}\p{N}]/u.test(ch) ? ch : '؟';
};

/** يطبّع البريد: حروف صغيرة بدون مسافات */
export const normEmail = s => String(s || '').trim().toLowerCase();
export const validEmail = s => /^[^\s@\/]+@[^\s@\/]+\.[^\s@\/]{2,}$/.test(s) && s.length <= 254;
