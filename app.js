// ============================================
// Журнал броней «Бобур»
// База: Google Firebase (Firestore) + вход по логину и паролю
// Права: admin — всё, book — брони, view — только просмотр
// (права проверяет и сайт, и сама база — правила Firestore)
// ============================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, query, where, onSnapshot,
  getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig, LOGIN_DOMAIN, OWNER_LOGIN } from './firebase-config.js?v=2026-11-07d';

// ================= Утилиты =================
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const todayStr = () => ymd(new Date());
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const fmtDay = s => parse(s).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = s => parse(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' });
const fmtMonth = (y, m) => cap(new Date(y, m, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', ''));
const money = n => Number(n).toLocaleString('ru-RU') + ' ₸';
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toTime = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const plural = (n, one, few, many) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Логин ↔ "почта" для Firebase
const loginToEmail = l => { l = l.trim().toLowerCase(); return l.includes('@') ? l : `${l}@${LOGIN_DOMAIN}`; };
const emailToLogin = e => String(e || '').replace('@' + LOGIN_DOMAIN, '');
const OWNER_EMAIL = loginToEmail(OWNER_LOGIN);
const ROLE_NAMES = { admin: 'Админ', book: 'Брони', view: 'Просмотр' };

// ================= Маска телефона: +7 701 123 45 67 =================
// value — всё, что набрано ПОСЛЕ "+7"
export function formatPhone(value) {
  let digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) digits = digits.slice(1);
  if (digits[0] === '8') digits = digits.slice(1);
  digits = digits.slice(0, 10);
  const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 8), digits.slice(8, 10)].filter(Boolean);
  return '+7' + (parts.length ? ' ' + parts.join(' ') : ' ');
}
function attachPhoneMask(input) {
  input.addEventListener('focus', () => { if (!input.value && !input.disabled) input.value = '+7 '; });
  input.addEventListener('blur', () => { if (input.value.replace(/\D/g, '').length <= 1) input.value = ''; });
  input.addEventListener('input', () => {
    const raw = input.value.startsWith('+7') ? input.value.slice(2) : input.value;
    input.value = formatPhone(raw);
    input.setSelectionRange(input.value.length, input.value.length);
  });
  input.addEventListener('keydown', e => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && input.value.length <= 3) e.preventDefault();
  });
}

// ================= Подключение к Firebase =================
const configured = !Object.values(firebaseConfig).some(v => String(v).includes('ВСТАВЬТЕ'));
if (!configured) { $('setupScreen').hidden = false; throw new Error('firebase-config.js не заполнен'); }
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
// Второе подключение — только чтобы админ мог создавать сотрудников, не выходя из своего аккаунта
const staffAuth = getAuth(initializeApp(firebaseConfig, 'staff-creator'));

// ================= Состояние =================
const state = {
  view: 'day',
  day: todayStr(),
  month: { y: new Date().getFullYear(), m: new Date().getMonth() },
  groups: [],             // [{id, name, order}]
  places: [],             // [{id, name, order, groupId}]
  settings: { start: '10:00', end: '22:00', step: 120 },
  bookings: new Map(),
  staff: [],              // [{id: email, role}]
  groupFilter: 'all',
  role: null,             // 'admin' | 'book' | 'view' | null (нет доступа)
  seen: null,             // {since, ids: {bookingId: время просмотра}} — что я уже смотрел
  loaded: false,
};
let unsubs = [];
const isAdmin = () => state.role === 'admin';
const canBook = () => state.role === 'admin' || state.role === 'book';

const notice = (text, warn = false) => {
  const n = $('notice');
  n.hidden = !text; n.textContent = text || ''; n.classList.toggle('warn', warn);
};
function slots() {
  const s = toMin(state.settings.start), e = toMin(state.settings.end), st = Number(state.settings.step) || 60;
  const out = [];
  for (let m = s; m <= e; m += st) out.push(toTime(m));
  return out;
}

// Места в порядке: сначала по порядку группы, внутри — по порядку места
function sortedPlaces() {
  const gOrder = new Map(state.groups.map(g => [g.id, g.order || 0]));
  const go = p => gOrder.has(p.groupId) ? gOrder.get(p.groupId) : 1e9; // без группы — в конце
  return [...state.places].sort((a, b) => go(a) - go(b) || (a.order || 0) - (b.order || 0));
}
const groupName = id => (state.groups.find(g => g.id === id) || {}).name || 'Без группы';

// ================= Вход и выход =================
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('loginErr').hidden = true;
  $('loginBtn').disabled = true;
  try {
    await signInWithEmailAndPassword(auth, loginToEmail($('loginEmail').value), $('loginPass').value);
  } catch (err) {
    const code = err && err.code || '';
    $('loginErr').textContent =
      code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found') || code.includes('invalid-email') ? 'Неверный логин или пароль.'
      : code.includes('too-many-requests') ? 'Слишком много попыток. Подождите пару минут.'
      : code.includes('network') ? 'Нет интернета. Проверьте подключение.'
      : 'Не удалось войти. Попробуйте ещё раз.';
    $('loginErr').hidden = false;
  } finally { $('loginBtn').disabled = false; }
});
$('logoutBtn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, user => {
  unsubs.forEach(u => u()); unsubs = []; stopData();
  state.role = null; state.loaded = false; state.staff = [];
  $('tab-places').hidden = true; $('tab-staff').hidden = true;
  if (!user) {
    // При выходе стираем с экрана всё, что видел прошлый сотрудник
    state.bookings = new Map(); state.places = []; state.groups = []; state.seen = null;
    ['dayGrid', 'daySummary', 'groupFilter', 'cal', 'results', 'placesList', 'groupsList', 'staffList', 'monthSummary'].forEach(id => $(id).innerHTML = '');
    $('appScreen').hidden = true; $('loginScreen').hidden = false; return;
  }
  $('loginScreen').hidden = true; $('appScreen').hidden = false;
  $('userEmail').textContent = emailToLogin(user.email);
  watchRole(user.email);
});

// ================= Права =================
function watchRole(email) {
  if (email === OWNER_EMAIL) { setRole('admin'); return; }
  $('roleBadge').textContent = '';
  notice('Проверяем права доступа…');
  unsubs.push(onSnapshot(doc(db, 'roles', email), snap => {
    setRole(snap.exists() ? snap.data().role : null);
  }, () => setRole(null)));
}

function setRole(role) {
  const prev = state.role;
  state.role = ROLE_NAMES[role] ? role : null;
  $('roleBadge').textContent = state.role ? ROLE_NAMES[state.role] : '';
  $('tab-places').hidden = !isAdmin();
  $('tab-staff').hidden = !isAdmin();
  if (!state.role) {
    stopData();
    notice('У этого логина пока нет доступа к журналу. Попросите админа выдать права во вкладке «Сотрудники».', true);
    $('dayGrid').innerHTML = ''; $('daySummary').textContent = ''; $('groupFilter').innerHTML = '';
    return;
  }
  notice('');
  if (!prev) startData();
  if ((state.view === 'places' || state.view === 'staff') && !isAdmin()) state.view = 'day';
  setView(state.view);
}

// ================= Подписки на базу =================
let dataUnsubs = [];
let monthUnsub = null, monthKey = '';
function stopData() { dataUnsubs.forEach(u => u()); dataUnsubs = []; monthUnsub = null; monthKey = ''; }

function startData() {
  stopData();
  state.loaded = false;
  const timer = setTimeout(() => { if (!state.loaded) notice('База пока не отвечает. Проверьте интернет — данные появятся сами.', true); }, 10000);

  dataUnsubs.push(onSnapshot(collection(db, 'groups'), snap => {
    state.groups = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
    if (state.groupFilter !== 'all' && state.groupFilter !== 'none' && !state.groups.some(g => g.id === state.groupFilter)) state.groupFilter = 'all';
    render();
  }, onDbError));

  dataUnsubs.push(onSnapshot(collection(db, 'places'), snap => {
    state.places = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.loaded = true; clearTimeout(timer);
    if ($('notice').classList.contains('warn')) notice('');
    render();
  }, onDbError));

  dataUnsubs.push(onSnapshot(doc(db, 'settings', 'main'), snap => {
    if (snap.exists()) state.settings = { ...state.settings, ...snap.data() };
    render();
  }, onDbError));

  if (isAdmin()) {
    dataUnsubs.push(onSnapshot(collection(db, 'roles'), snap => {
      state.staff = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.id.localeCompare(b.id));
      render();
    }, onDbError));
  }

  // Что этот сотрудник уже просмотрел (у каждого своё)
  const myEmail = auth.currentUser.email;
  dataUnsubs.push(onSnapshot(doc(db, 'seen', myEmail), snap => {
    if (!snap.exists()) {
      // Первый вход с этой функцией: всё, что было раньше, считаем просмотренным
      state.seen = { since: new Date().toISOString(), ids: {} };
      setDoc(doc(db, 'seen', myEmail), state.seen).catch(() => {});
    } else {
      state.seen = { since: '', ids: {}, ...snap.data() };
    }
    render();
  }, () => { state.seen = null; }));

  const d = parse(state.day);
  ensureMonth(d.getFullYear(), d.getMonth());
}

// ================= Новые брони (красные) =================
// Новая = поставлена или изменена ДРУГИМ сотрудником и я её ещё не открывал
const myLogin = () => emailToLogin(auth.currentUser?.email);
function isNew(b) {
  if (!state.seen || !b || !b.updatedBy || b.updatedBy === myLogin()) return false;
  const changed = b.updatedAt || b.createdAt || '';
  const seenAt = state.seen.ids?.[b.id] || state.seen.since || '';
  return changed > seenAt;
}
let seenTimer = null;
function markSeen(ids) {
  if (!state.seen || !ids.length) return;
  const now = new Date().toISOString();
  const today = todayStr();
  // Храним отметки только для сегодняшних и будущих броней (дата — начало id брони)
  const keep = {};
  for (const [id, t] of Object.entries(state.seen.ids || {})) if (id.slice(0, 10) >= today) keep[id] = t;
  ids.forEach(id => { keep[id] = now; });
  state.seen = { ...state.seen, ids: keep };
  render();
  clearTimeout(seenTimer);
  seenTimer = setTimeout(() => setDoc(doc(db, 'seen', auth.currentUser.email), state.seen).catch(() => {}), 400);
}
function newCountBadge() {
  const n = [...state.bookings.values()].filter(isNew).length;
  const tab = $('tab-month');
  tab.innerHTML = 'Месяц' + (n ? ` <span class="tab-dot" aria-label="${n} новых">${n}</span>` : '');
}

function ensureMonth(y, m) {
  if (!state.role) return;
  const from = ymd(new Date(y, m, -6)), to = ymd(new Date(y, m + 1, 7));
  if (from + to === monthKey) return;
  monthKey = from + to;
  if (monthUnsub) { monthUnsub(); dataUnsubs = dataUnsubs.filter(u => u !== monthUnsub); }
  const q = query(collection(db, 'bookings'), where('date', '>=', from), where('date', '<=', to));
  monthUnsub = onSnapshot(q, snap => {
    state.bookings = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    render();
  }, onDbError);
  dataUnsubs.push(monthUnsub);
}

function onDbError(err) {
  notice(err && err.code === 'permission-denied'
    ? 'Нет доступа к базе. Проверьте права сотрудника или правила Firestore (см. инструкцию).'
    : 'Связь с базой потеряна. Обновите страницу.', true);
}

// ================= Вкладки =================
function setView(v) {
  if ((v === 'places' || v === 'staff') && !isAdmin()) v = 'day';
  state.view = v;
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === v)));
  ['day', 'month', 'places', 'staff'].forEach(k => $('view-' + k).hidden = k !== v);
  const d = parse(state.day);
  if (v === 'month') state.month = { y: d.getFullYear(), m: d.getMonth() };
  ensureMonth(v === 'month' ? state.month.y : d.getFullYear(), v === 'month' ? state.month.m : d.getMonth());
  render();
  try { history.replaceState(null, '', '#' + v); } catch (e) {}
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)));

function render() {
  if (!state.role) return;
  newCountBadge();
  if (state.view === 'day') renderDay();
  if (state.view === 'month') renderMonth();
  if (state.view === 'places') renderPlaces();
  if (state.view === 'staff') renderStaff();
}

// ================= День =================
function renderGroupFilter(places, dayList) {
  const box = $('groupFilter');
  const gOf = p => state.groups.some(g => g.id === p.groupId) ? p.groupId : 'none';
  const placeGroup = new Map(places.map(p => [p.id, gOf(p)]));
  const cnt = {}, fresh = {};
  for (const b of dayList) {
    const g = placeGroup.get(b.placeId); if (!g) continue;
    cnt[g] = (cnt[g] || 0) + 1; cnt.all = (cnt.all || 0) + 1;
    if (isNew(b)) { fresh[g] = (fresh[g] || 0) + 1; fresh.all = (fresh.all || 0) + 1; }
  }
  // Число — сколько броней в группе; красная точка — есть новые, которые вы ещё не смотрели
  const badge = id => (cnt[id] ? `<span class="cnt">${cnt[id]}</span>` : '') +
    (fresh[id] ? `<span class="gdot" title="Новых: ${fresh[id]}" aria-label="новых: ${fresh[id]}"></span>` : '');
  const used = new Set(places.map(p => state.groups.some(g => g.id === p.groupId) ? p.groupId : 'none'));
  const chips = [{ id: 'all', name: 'Все' }, ...state.groups.filter(g => used.has(g.id))];
  if (used.has('none') && state.groups.length) chips.push({ id: 'none', name: 'Без группы' });
  if (chips.length <= 2) { box.innerHTML = ''; state.groupFilter = 'all'; return; } // одна группа — фильтр не нужен
  box.innerHTML = chips.map(c => `<button class="gchip" role="tab" data-g="${esc(c.id)}" aria-selected="${state.groupFilter === c.id}">${esc(c.name)}${badge(c.id)}</button>`).join('');
  box.querySelectorAll('.gchip').forEach(b => b.onclick = () => { state.groupFilter = b.dataset.g; renderDay(); });
}

function renderDay() {
  const date = state.day;
  $('dayTitle').textContent = date === todayStr() ? 'Сегодня, ' + fmtDay(date) : cap(fmtDay(date));
  $('dayPick').value = date;
  const grid = $('dayGrid');

  if (!state.loaded) {
    grid.innerHTML = '<div class="empty"><b>Загружаем брони…</b>Таблица появится через пару секунд.</div>';
    $('daySummary').textContent = ''; $('groupFilter').innerHTML = '';
    return;
  }
  const all = sortedPlaces();
  if (!all.length) {
    grid.innerHTML = isAdmin()
      ? `<div class="empty"><b>Пока нет ни одного места</b>Добавьте группы и места во вкладке «Места» — они станут столбцами таблицы.<br><br><button class="btn btn--primary" id="goPlaces">Добавить места</button></div>`
      : `<div class="empty"><b>Места ещё не добавлены</b>Их добавляет админ.</div>`;
    if ($('goPlaces')) $('goPlaces').onclick = () => setView('places');
    $('daySummary').textContent = ''; $('groupFilter').innerHTML = '';
    return;
  }
  const dayAll = [...state.bookings.values()].filter(b => b.date === date);
  renderGroupFilter(all, dayAll);
  const inGroup = p => state.groupFilter === 'all' ? true
    : state.groupFilter === 'none' ? !state.groups.some(g => g.id === p.groupId)
    : p.groupId === state.groupFilter;
  const places = all.filter(inGroup);

  const list = [...state.bookings.values()].filter(b => b.date === date);
  const base = slots();
  const extra = [...new Set(list.map(b => b.time))].filter(t => !base.includes(t));
  const rows = [...base, ...extra].sort((a, b) => toMin(a) - toMin(b));
  const placeIds = new Set(places.map(p => p.id));
  const shown = list.filter(b => placeIds.has(b.placeId));
  const byCell = new Map(shown.map(b => [b.placeId + '|' + b.time, b]));

  const total = rows.length * places.length;
  const dep = shown.reduce((s, b) => s + (Number(b.deposit) || 0), 0);
  const guests = shown.reduce((s, b) => s + (Number(b.guests) || 0), 0);
  $('daySummary').innerHTML =
    `<span>Броней: <b>${byCell.size}</b> из ${total}</span><span>Свободно: <b>${total - byCell.size}</b></span>` +
    (guests ? `<span>Гостей: <b>${guests}</b></span>` : '') +
    (dep ? `<span>Задатков: <b>${money(dep)}</b></span>` : '');
  const dayNew = dayAll.filter(isNew);
  if (dayNew.length) {
    $('daySummary').innerHTML += `<span class="new-pill">Новых: ${dayNew.length}</span><button class="btn btn--small" id="seenDay">Отметить просмотренными</button>`;
    $('seenDay').onclick = () => markSeen(dayNew.map(b => b.id));
  }

  // Шапка: строка групп (если групп больше одной) + строка мест
  const spans = [];
  for (const p of places) {
    const g = state.groups.some(x => x.id === p.groupId) ? p.groupId : 'none';
    if (spans.length && spans[spans.length - 1].g === g) spans[spans.length - 1].n++;
    else spans.push({ g, n: 1 });
  }
  let html = '<div class="grid-scroll"><table class="day"><thead>';
  if (state.groups.length && (spans.length > 1 || spans[0].g !== 'none')) {
    html += '<tr class="groups"><th class="time"></th>' + spans.map(s => `<th colspan="${s.n}">${esc(groupName(s.g))}</th>`).join('') + '</tr>';
  }
  html += '<tr><th class="time">Время</th>' + places.map(p => `<th>${esc(p.name)}</th>`).join('') + '</tr></thead><tbody>';
  for (const t of rows) {
    html += `<tr><td class="time${extra.includes(t) ? ' extra' : ''}">${t}</td>`;
    for (const p of places) {
      const b = byCell.get(p.id + '|' + t);
      if (b) {
        const meta = [b.phone ? `<span class="nowrap">${esc(b.phone)}</span>` : '', b.guests ? esc(b.guests + ' ' + plural(b.guests, 'гость', 'гостя', 'гостей')) : ''].filter(Boolean).join(' · ');
        const fresh = isNew(b);
        html += `<td class="cell"><button class="slot slot--booked${fresh ? ' slot--new' : ''}" data-id="${esc(b.id)}">
          ${fresh ? `<span class="new-tag">Новая · ${esc(b.updatedBy)}</span>` : ''}
          <span class="slot__name">${esc(b.name)}</span>
          ${meta ? `<span class="slot__meta">${meta}</span>` : ''}
          ${b.comment ? `<span class="slot__meta">${esc(b.comment)}</span>` : ''}
          ${Number(b.deposit) ? `<span class="chip">Задаток ${money(b.deposit)}</span>` : ''}
        </button></td>`;
      } else if (canBook()) {
        html += `<td class="cell"><button class="slot slot--free" data-place="${esc(p.id)}" data-time="${t}">Свободно <span>+ бронь</span></button></td>`;
      } else {
        html += `<td class="cell"><button class="slot slot--free" disabled>Свободно</button></td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  grid.innerHTML = html;
  grid.querySelectorAll('.slot--booked').forEach(el => el.onclick = () => openDialog(state.bookings.get(el.dataset.id)));
  grid.querySelectorAll('.slot--free:not([disabled])').forEach(el => el.onclick = () => openDialog(null, { placeId: el.dataset.place, time: el.dataset.time, date }));
}

function goDay(date) {
  state.day = date;
  const d = parse(date);
  ensureMonth(d.getFullYear(), d.getMonth());
  render();
}
$('dayPrev').onclick = () => goDay(addDays(state.day, -1));
$('dayNext').onclick = () => goDay(addDays(state.day, 1));
$('dayToday').onclick = () => goDay(todayStr());
$('dayPick').onchange = e => e.target.value && goDay(e.target.value);

// ================= Месяц =================
function renderMonth() {
  const { y, m } = state.month;
  $('monthTitle').textContent = fmtMonth(y, m);
  const offset = (new Date(y, m, 1).getDay() + 6) % 7;
  const start = new Date(y, m, 1 - offset);
  const today = todayStr();

  const counts = new Map(), deps = new Map(), news = new Map();
  let monthCount = 0, monthDep = 0;
  for (const b of state.bookings.values()) {
    counts.set(b.date, (counts.get(b.date) || 0) + 1);
    if (isNew(b)) news.set(b.date, (news.get(b.date) || 0) + 1);
    deps.set(b.date, (deps.get(b.date) || 0) + (Number(b.deposit) || 0));
    const d = parse(b.date);
    if (d.getFullYear() === y && d.getMonth() === m) { monthCount++; monthDep += Number(b.deposit) || 0; }
  }
  $('monthSummary').innerHTML = `<span>Броней за месяц: <b>${monthCount}</b></span>` + (monthDep ? `<span>Задатков: <b>${money(monthDep)}</b></span>` : '');
  const allNew = [...state.bookings.values()].filter(isNew);
  if (allNew.length) {
    $('monthSummary').innerHTML += `<span class="new-pill">Новых: ${allNew.length}</span><button class="btn btn--small" id="seenAll">Все просмотрены</button>`;
    $('seenAll').onclick = () => markSeen(allNew.map(b => b.id));
  }

  let html = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => `<div class="cal__dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    if (i >= 35 && d.getMonth() !== m) break;
    const s = ymd(d), c = counts.get(s) || 0, dp = deps.get(s) || 0, nw = news.get(s) || 0;
    const cls = ['cal__day', d.getMonth() !== m ? 'other' : '', s === today ? 'today' : '', nw ? 'has-new' : ''].join(' ');
    html += `<button class="${cls}" data-date="${s}">
      <span class="cal__num">${d.getDate()}</span>
      ${c ? `<span class="cal__count">${c} ${plural(c, 'бронь', 'брони', 'броней')}</span>` : ''}
      ${nw ? `<span class="cal__new">${nw} ${plural(nw, 'новая', 'новые', 'новых')}</span>` : ''}
      ${dp ? `<span class="cal__dep">${money(dp)}</span>` : ''}
    </button>`;
  }
  $('cal').innerHTML = html;
  $('cal').querySelectorAll('.cal__day').forEach(el => el.onclick = () => { state.day = el.dataset.date; setView('day'); });
}
const shiftMonth = n => {
  const d = new Date(state.month.y, state.month.m + n, 1);
  state.month = { y: d.getFullYear(), m: d.getMonth() };
  ensureMonth(state.month.y, state.month.m);
  render();
};
$('monthPrev').onclick = () => shiftMonth(-1);
$('monthNext').onclick = () => shiftMonth(1);
$('monthNow').onclick = () => { const d = new Date(); state.month = { y: d.getFullYear(), m: d.getMonth() }; ensureMonth(state.month.y, state.month.m); render(); };

$('searchForm').onsubmit = async e => {
  e.preventDefault();
  const q = $('searchInput').value.trim().toLowerCase();
  const box = $('results');
  if (!q) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="empty">Ищем…</div>';
  try {
    const snap = await getDocs(collection(db, 'bookings'));
    const digits = q.replace(/\D/g, '');
    const found = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(b => (b.name || '').toLowerCase().includes(q) || (digits.length >= 3 && (b.phone || '').replace(/\D/g, '').includes(digits)))
      .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    if (!found.length) { box.innerHTML = '<div class="empty">Ничего не найдено.</div>'; return; }
    const placeName = id => (state.places.find(p => p.id === id) || {}).name || 'место удалено';
    box.innerHTML = found.slice(0, 50).map(b => `<button class="result" data-date="${esc(b.date)}">
      <b>${esc(b.name)}</b><span>${esc(fmtShort(b.date))}, ${esc(b.time)} · ${esc(placeName(b.placeId))}</span>
      ${b.phone ? `<span>${esc(b.phone)}</span>` : ''}${Number(b.deposit) ? `<span class="chip">Задаток ${money(b.deposit)}</span>` : ''}
    </button>`).join('');
    box.querySelectorAll('.result').forEach(el => el.onclick = () => { state.day = el.dataset.date; setView('day'); });
  } catch (err) {
    box.innerHTML = '<div class="empty">Не получилось выполнить поиск. Попробуйте ещё раз.</div>';
  }
};

// ================= Группы, места, время (админ) =================
const groupOptions = selected =>
  `<option value="">Без группы</option>` + state.groups.map(g => `<option value="${esc(g.id)}" ${g.id === selected ? 'selected' : ''}>${esc(g.name)}</option>`).join('');

// Поменять местами два элемента по полю order
function swapOrder(col, list, i, j) {
  const a = list[i], b = list[j];
  if (!a || !b) return;
  const oa = a.order === b.order ? j : b.order, ob = a.order === b.order ? i : a.order;
  write(async () => {
    await updateDoc(doc(db, col, a.id), { order: oa });
    await updateDoc(doc(db, col, b.id), { order: ob });
  });
}

function inlineConfirm(li, text, onYes) {
  if (li.querySelector('.confirm')) return;
  const box = document.createElement('div');
  box.className = 'confirm'; box.style.width = '100%';
  box.innerHTML = `${text}<span class="spacer"></span><button class="btn" data-n>Нет</button><button class="btn btn--danger-solid" data-y>Удалить</button>`;
  li.appendChild(box);
  box.querySelector('[data-n]').onclick = () => box.remove();
  box.querySelector('[data-y]').onclick = onYes;
}

function renderPlaces() {
  // --- Группы ---
  const gl = $('groupsList');
  gl.innerHTML = !state.groups.length
    ? '<li class="slots-preview">Групп пока нет. Места можно вести и без групп.</li>'
    : state.groups.map((g, i) => {
        const n = state.places.filter(p => p.groupId === g.id).length;
        return `<li class="place" data-id="${esc(g.id)}">
          <input type="text" value="${esc(g.name)}" maxlength="30" aria-label="Название группы">
          <span class="slots-preview" style="margin:0">${n} ${plural(n, 'место', 'места', 'мест')}</span>
          <button class="btn btn--icon" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Выше">↑</button>
          <button class="btn btn--icon" data-act="down" ${i === state.groups.length - 1 ? 'disabled' : ''} aria-label="Ниже">↓</button>
          <button class="btn btn--danger" data-act="del">Удалить</button>
        </li>`;
      }).join('');
  gl.querySelectorAll('.place').forEach(li => {
    const id = li.dataset.id, i = state.groups.findIndex(g => g.id === id);
    const input = li.querySelector('input');
    input.onchange = () => {
      const name = input.value.trim(), g = state.groups[i];
      if (!name || name === g.name) { input.value = g.name; return; }
      write(() => updateDoc(doc(db, 'groups', id), { name }));
    };
    li.querySelectorAll('button').forEach(btn => btn.onclick = () => {
      if (btn.dataset.act === 'up') return swapOrder('groups', state.groups, i, i - 1);
      if (btn.dataset.act === 'down') return swapOrder('groups', state.groups, i, i + 1);
      const inside = state.places.filter(p => p.groupId === id);
      inlineConfirm(li, `Удалить группу «${esc(state.groups[i].name)}»?${inside.length ? ` Её места (${inside.length}) останутся, но будут «Без группы».` : ''}`, () =>
        write(async () => {
          for (const p of inside) await updateDoc(doc(db, 'places', p.id), { groupId: '' });
          await deleteDoc(doc(db, 'groups', id));
        }));
    });
  });

  // --- Места ---
  const places = sortedPlaces();
  const ul = $('placesList');
  ul.innerHTML = !places.length
    ? '<li class="slots-preview">Мест пока нет — добавьте первое ниже.</li>'
    : places.map(p => `<li class="place" data-id="${esc(p.id)}">
        <input type="text" value="${esc(p.name)}" maxlength="40" aria-label="Название места">
        <select aria-label="Группа места">${groupOptions(p.groupId)}</select>
        <button class="btn btn--icon" data-act="up" aria-label="Выше">↑</button>
        <button class="btn btn--icon" data-act="down" aria-label="Ниже">↓</button>
        <button class="btn btn--danger" data-act="del">Удалить</button>
      </li>`).join('');
  ul.querySelectorAll('.place').forEach(li => {
    const id = li.dataset.id, p = state.places.find(x => x.id === id);
    const input = li.querySelector('input'), sel = li.querySelector('select');
    input.onchange = () => {
      const name = input.value.trim();
      if (!name || name === p.name) { input.value = p.name; return; }
      write(() => updateDoc(doc(db, 'places', id), { name }));
    };
    sel.onchange = () => write(() => updateDoc(doc(db, 'places', id), { groupId: sel.value }));
    // Двигаем только внутри своей группы
    const same = places.filter(x => (x.groupId || '') === (p.groupId || ''));
    const i = same.findIndex(x => x.id === id);
    li.querySelector('[data-act="up"]').disabled = i === 0;
    li.querySelector('[data-act="down"]').disabled = i === same.length - 1;
    li.querySelectorAll('button').forEach(btn => btn.onclick = () => {
      if (btn.dataset.act === 'up') return swapOrder('places', same, i, i - 1);
      if (btn.dataset.act === 'down') return swapOrder('places', same, i, i + 1);
      const future = [...state.bookings.values()].filter(b => b.placeId === id && b.date >= todayStr()).length;
      inlineConfirm(li, `Удалить «${esc(p.name)}»?${future ? ` На него есть брони (${future}) — они пропадут из таблицы.` : ''}`,
        () => write(() => deleteDoc(doc(db, 'places', id))));
    });
  });
  const keep = $('newPlaceGroup').value;
  $('newPlaceGroup').innerHTML = groupOptions(keep);

  // --- Время ---
  const opts = [];
  for (let m = 0; m < 24 * 60; m += 30) opts.push(toTime(m));
  const fill = (sel, val) => { sel.innerHTML = opts.map(t => `<option ${t === val ? 'selected' : ''}>${t}</option>`).join(''); };
  fill($('slotStart'), state.settings.start);
  fill($('slotEnd'), state.settings.end);
  $('slotStep').value = String(state.settings.step);
  $('slotsPreview').textContent = 'Строки сейчас: ' + slots().join(', ');
}

$('addGroupForm').onsubmit = e => {
  e.preventDefault();
  const name = $('newGroup').value.trim();
  if (!name) return;
  const order = state.groups.reduce((m, g) => Math.max(m, g.order || 0), 0) + 1;
  write(async () => { await addDoc(collection(db, 'groups'), { name, order }); $('newGroup').value = ''; });
};
$('addPlaceForm').onsubmit = e => {
  e.preventDefault();
  const name = $('newPlace').value.trim();
  if (!name) return;
  const order = state.places.reduce((m, p) => Math.max(m, p.order || 0), 0) + 1;
  const groupId = $('newPlaceGroup').value;
  write(async () => { await addDoc(collection(db, 'places'), { name, order, groupId }); $('newPlace').value = ''; });
};
$('slotsForm').onsubmit = e => {
  e.preventDefault();
  const s = { start: $('slotStart').value, end: $('slotEnd').value, step: Number($('slotStep').value) };
  if (toMin(s.end) < toMin(s.start)) { $('slotsPreview').textContent = 'Время «до» должно быть позже времени «с».'; return; }
  write(() => setDoc(doc(db, 'settings', 'main'), s));
};

// ================= Сотрудники (админ) =================
function renderStaff() {
  const me = auth.currentUser?.email;
  const rows = [{ id: OWNER_EMAIL, role: 'admin', owner: true }, ...state.staff.filter(s => s.id !== OWNER_EMAIL)];
  $('staffList').innerHTML = rows.map(s => `<li class="place" data-id="${esc(s.id)}">
      <span class="staff-login">${esc(emailToLogin(s.id))}${s.id === me ? ' <span class="staff-you">(вы)</span>' : ''}${s.owner ? ' <span class="staff-you">· главный админ</span>' : ''}</span>
      <select aria-label="Права" ${s.owner || s.id === me ? 'disabled' : ''}>
        ${Object.entries(ROLE_NAMES).map(([k, v]) => `<option value="${k}" ${s.role === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      <button class="btn btn--danger" data-act="del" ${s.owner || s.id === me ? 'disabled' : ''}>Убрать доступ</button>
    </li>`).join('');
  $('staffList').querySelectorAll('.place').forEach(li => {
    const id = li.dataset.id;
    const sel = li.querySelector('select');
    sel.onchange = () => write(() => setDoc(doc(db, 'roles', id), { role: sel.value }));
    li.querySelector('[data-act="del"]').onclick = () =>
      inlineConfirm(li, `Убрать доступ у «${esc(emailToLogin(id))}»? Войти он сможет, но журнал не увидит.`, () =>
        write(() => deleteDoc(doc(db, 'roles', id))));
  });
}

$('addStaffForm').onsubmit = async e => {
  e.preventDefault();
  const msg = $('staffMsg');
  const login = $('staffLogin').value.trim().toLowerCase();
  const pass = $('staffPass').value;
  const role = $('staffRole').value;
  msg.className = 'slots-preview';
  if (!/^[a-z0-9._-]{2,30}$/.test(login)) { msg.textContent = 'Логин — латинские буквы, цифры, точка или дефис, от 2 символов.'; msg.classList.add('msg-err'); return; }
  if (pass.length < 6) { msg.textContent = 'Пароль должен быть не короче 6 символов.'; msg.classList.add('msg-err'); return; }
  const email = loginToEmail(login);
  $('addStaffBtn').disabled = true;
  try {
    let existed = false;
    try {
      await createUserWithEmailAndPassword(staffAuth, email, pass);
    } catch (err) {
      if (err && err.code === 'auth/email-already-in-use') existed = true;
      else throw err;
    } finally {
      try { await signOut(staffAuth); } catch (e2) {}
    }
    await setDoc(doc(db, 'roles', email), { role });
    msg.textContent = existed
      ? `Логин «${login}» уже был — права обновлены на «${ROLE_NAMES[role]}». Пароль остался прежним.`
      : `Готово: логин «${login}», пароль «${pass}», права «${ROLE_NAMES[role]}». Передайте их сотруднику.`;
    msg.classList.add('msg-ok');
    $('staffLogin').value = ''; $('staffPass').value = '';
  } catch (err) {
    msg.textContent = err && err.code === 'permission-denied'
      ? 'База не дала сохранить права. Проверьте правила Firestore (см. инструкцию).'
      : err && err.code === 'auth/weak-password' ? 'Слишком простой пароль.'
      : 'Не удалось создать сотрудника. Проверьте интернет и попробуйте ещё раз.';
    msg.classList.add('msg-err');
  } finally { $('addStaffBtn').disabled = false; }
};

// ================= Окно брони =================
attachPhoneMask($('fPhone'));
let editing = null;

function openDialog(b, slot) {
  if (b && isNew(b)) markSeen([b.id]);
  editing = b ? { ...b } : { ...slot };
  const place = state.places.find(p => p.id === editing.placeId);
  const edit = canBook();
  $('dlgTitle').textContent = b ? 'Бронь' : 'Новая бронь';
  $('dlgSub').textContent = `${place ? place.name : 'Место удалено'} · ${fmtDay(editing.date)}, ${editing.time}`;
  $('fName').value = b?.name || '';
  $('fPhone').value = b?.phone || '';
  $('fGuests').value = b?.guests || '';
  $('fDeposit').value = b && Number(b.deposit) ? b.deposit : '';
  $('fComment').value = b?.comment || '';
  ['fName', 'fPhone', 'fGuests', 'fDeposit', 'fComment'].forEach(id => $(id).disabled = !edit);
  $('dlgError').hidden = true;
  $('dlgConfirm').hidden = true;
  $('dlgDelete').hidden = !b || !edit;
  $('dlgSave').hidden = !edit;
  $('dlg').showModal();
  if (edit) setTimeout(() => $('fName').focus(), 30);
}
const closeDialog = () => { $('dlg').close(); editing = null; };
const showErr = t => { $('dlgError').textContent = t; $('dlgError').hidden = false; };
$('dlgCancel').onclick = closeDialog;
$('dlgDelete').onclick = () => { $('dlgConfirm').hidden = false; };
$('dlgConfirmNo').onclick = () => { $('dlgConfirm').hidden = true; };
$('dlgConfirmYes').onclick = () => {
  const id = editing.id;
  write(async () => { await deleteDoc(doc(db, 'bookings', id)); closeDialog(); }, $('dlgError'));
};

$('dlgForm').onsubmit = e => {
  e.preventDefault();
  if (!canBook()) return;
  const name = $('fName').value.trim();
  if (!name) { showErr('Укажите имя гостя.'); $('fName').focus(); return; }
  const phone = $('fPhone').value.trim();
  const phoneDigits = phone.replace(/\D/g, '');
  if (phoneDigits.length > 1 && phoneDigits.length < 11) { showErr('Номер неполный: нужно 10 цифр после +7.'); $('fPhone').focus(); return; }
  const data = {
    date: editing.date, time: editing.time, placeId: editing.placeId,
    name,
    phone: phoneDigits.length === 11 ? phone : '',
    guests: Number($('fGuests').value) || 0,
    deposit: Math.max(0, Number($('fDeposit').value) || 0),
    comment: $('fComment').value.trim(),
    updatedAt: new Date().toISOString(),
    updatedBy: emailToLogin(auth.currentUser?.email),
  };
  const isNew = !editing.id;
  const id = editing.id || `${editing.date}_${editing.placeId}_${editing.time.replace(':', '-')}`;
  write(async () => {
    if (isNew) {
      const existing = await getDoc(doc(db, 'bookings', id));
      if (existing.exists()) { showErr('Это время уже заняли с другого устройства. Закройте окно — таблица обновится.'); return; }
      data.createdAt = data.updatedAt;
      await setDoc(doc(db, 'bookings', id), data);
    } else {
      await updateDoc(doc(db, 'bookings', id), data);
    }
    closeDialog();
  }, $('dlgError'));
};

// ================= Запись =================
let busy = false;
async function write(fn, errEl) {
  if (busy) return;
  busy = true;
  try { await fn(); }
  catch (err) {
    const msg = err && err.code === 'permission-denied'
      ? 'У вас нет прав на это действие.'
      : 'Не удалось сохранить. Проверьте интернет и попробуйте ещё раз.';
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; } else notice(msg, true);
  } finally { busy = false; }
}

const startView = location.hash.replace('#', '');
if (['day', 'month', 'places', 'staff'].includes(startView)) state.view = startView;
