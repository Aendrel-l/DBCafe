// ============================================
// Журнал броней «Бобур»
// База: Google Firebase (Firestore) + вход по почте и паролю
// ============================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, query, where, onSnapshot,
  getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

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

// ================= Маска телефона: +7 701 123 45 67 =================
// value — всё, что набрано ПОСЛЕ "+7"
export function formatPhone(value) {
  let digits = String(value).replace(/\D/g, '');
  // Вставили номер целиком (+7 701…, 8 701…, 7701…) — убираем код страны
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) digits = digits.slice(1);
  // Набрали по привычке 8 701… — восьмёрку отбрасываем (номера в Казахстане после +7 начинаются с 7)
  if (digits[0] === '8') digits = digits.slice(1);
  digits = digits.slice(0, 10);
  const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 8), digits.slice(8, 10)].filter(Boolean);
  return '+7' + (parts.length ? ' ' + parts.join(' ') : ' ');
}

function attachPhoneMask(input) {
  input.addEventListener('focus', () => { if (!input.value) input.value = '+7 '; });
  input.addEventListener('blur', () => { if (input.value.replace(/\D/g, '').length <= 1) input.value = ''; });
  input.addEventListener('input', () => {
    // всё, что набрано после "+7", считаем номером
    const raw = input.value.startsWith('+7') ? input.value.slice(2) : input.value;
    input.value = formatPhone(raw);
    input.setSelectionRange(input.value.length, input.value.length);
  });
  input.addEventListener('keydown', e => {
    // не даём стереть "+7 "
    if ((e.key === 'Backspace' || e.key === 'Delete') && input.value.length <= 3) e.preventDefault();
  });
}

// ================= Подключение к Firebase =================
const configured = !Object.values(firebaseConfig).some(v => String(v).includes('ВСТАВЬТЕ'));
if (!configured) {
  $('setupScreen').hidden = false;
  throw new Error('firebase-config.js не заполнен');
}
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ================= Состояние =================
const state = {
  view: 'day',
  day: todayStr(),
  month: { y: new Date().getFullYear(), m: new Date().getMonth() },
  places: [],
  settings: { start: '10:00', end: '22:00', step: 120 },
  bookings: new Map(),
  loaded: false,
};
let unsubs = [];

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

// ================= Вход и выход =================
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('loginErr').hidden = true;
  $('loginBtn').disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $('loginEmail').value.trim(), $('loginPass').value);
  } catch (err) {
    const code = err && err.code || '';
    $('loginErr').textContent =
      code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found') ? 'Неверная почта или пароль.'
      : code.includes('too-many-requests') ? 'Слишком много попыток. Подождите пару минут.'
      : code.includes('network') ? 'Нет интернета. Проверьте подключение.'
      : 'Не удалось войти. Попробуйте ещё раз.';
    $('loginErr').hidden = false;
  } finally { $('loginBtn').disabled = false; }
});
$('logoutBtn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, user => {
  unsubs.forEach(u => u()); unsubs = []; monthUnsub = null; monthKey = '';
  if (!user) {
    $('appScreen').hidden = true; $('loginScreen').hidden = false;
    return;
  }
  $('loginScreen').hidden = true; $('appScreen').hidden = false;
  $('userEmail').textContent = user.email || '';
  startData();
});

// ================= Подписки на базу =================
let monthUnsub = null, monthKey = '';
function startData() {
  state.loaded = false;
  const timer = setTimeout(() => { if (!state.loaded) notice('База пока не отвечает. Проверьте интернет — данные появятся сами.', true); }, 10000);

  unsubs.push(onSnapshot(collection(db, 'places'), snap => {
    state.places = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
    state.loaded = true; clearTimeout(timer); notice('');
    render();
  }, onDbError));

  unsubs.push(onSnapshot(doc(db, 'settings', 'main'), snap => {
    if (snap.exists()) state.settings = { ...state.settings, ...snap.data() };
    render();
  }, onDbError));

  const d = parse(state.day);
  ensureMonth(d.getFullYear(), d.getMonth());
  setView(state.view);
}

function ensureMonth(y, m) {
  if (!auth.currentUser) return;
  const from = ymd(new Date(y, m, -6)), to = ymd(new Date(y, m + 1, 7));
  if (from + to === monthKey) return;
  monthKey = from + to;
  if (monthUnsub) { monthUnsub(); unsubs = unsubs.filter(u => u !== monthUnsub); }
  const q = query(collection(db, 'bookings'), where('date', '>=', from), where('date', '<=', to));
  monthUnsub = onSnapshot(q, snap => {
    state.bookings = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    render();
  }, onDbError);
  unsubs.push(monthUnsub);
}

function onDbError(err) {
  notice(err && err.code === 'permission-denied'
    ? 'Нет доступа к базе. Проверьте правила Firestore (см. инструкцию).'
    : 'Связь с базой потеряна. Обновите страницу.', true);
}

// ================= Вкладки =================
function setView(v) {
  state.view = v;
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === v)));
  ['day', 'month', 'places'].forEach(k => $('view-' + k).hidden = k !== v);
  const d = parse(state.day);
  if (v === 'month') state.month = { y: d.getFullYear(), m: d.getMonth() };
  ensureMonth(v === 'month' ? state.month.y : d.getFullYear(), v === 'month' ? state.month.m : d.getMonth());
  render();
  try { history.replaceState(null, '', '#' + v); } catch (e) {}
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)));

function render() {
  if (state.view === 'day') renderDay();
  if (state.view === 'month') renderMonth();
  if (state.view === 'places') renderPlaces();
}

// ================= День =================
function renderDay() {
  const date = state.day;
  $('dayTitle').textContent = date === todayStr() ? 'Сегодня, ' + fmtDay(date) : cap(fmtDay(date));
  $('dayPick').value = date;
  const grid = $('dayGrid');

  if (!state.loaded) {
    grid.innerHTML = '<div class="empty"><b>Загружаем брони…</b>Таблица появится через пару секунд.</div>';
    $('daySummary').textContent = '';
    return;
  }
  if (!state.places.length) {
    grid.innerHTML = `<div class="empty"><b>Пока нет ни одного места</b>Добавьте беседки или столы во вкладке «Места» — они станут столбцами таблицы.<br><br><button class="btn btn--primary" id="goPlaces">Добавить места</button></div>`;
    $('goPlaces').onclick = () => setView('places');
    $('daySummary').textContent = '';
    return;
  }

  const list = [...state.bookings.values()].filter(b => b.date === date);
  const base = slots();
  const extra = [...new Set(list.map(b => b.time))].filter(t => !base.includes(t));
  const rows = [...base, ...extra].sort((a, b) => toMin(a) - toMin(b));
  const placeIds = new Set(state.places.map(p => p.id));
  const byCell = new Map(list.filter(b => placeIds.has(b.placeId)).map(b => [b.placeId + '|' + b.time, b]));

  const total = rows.length * state.places.length;
  const busy = byCell.size;
  const dep = list.reduce((s, b) => s + (Number(b.deposit) || 0), 0);
  const guests = list.reduce((s, b) => s + (Number(b.guests) || 0), 0);
  $('daySummary').innerHTML =
    `<span>Броней: <b>${busy}</b> из ${total}</span><span>Свободно: <b>${total - busy}</b></span>` +
    (guests ? `<span>Гостей: <b>${guests}</b></span>` : '') +
    (dep ? `<span>Задатков: <b>${money(dep)}</b></span>` : '');

  let html = '<div class="grid-scroll"><table class="day"><thead><tr><th class="time">Время</th>';
  for (const p of state.places) html += `<th>${esc(p.name)}</th>`;
  html += '</tr></thead><tbody>';
  for (const t of rows) {
    html += `<tr><td class="time${extra.includes(t) ? ' extra' : ''}">${t}</td>`;
    for (const p of state.places) {
      const b = byCell.get(p.id + '|' + t);
      if (b) {
        const meta = [b.phone ? `<span class="nowrap">${esc(b.phone)}</span>` : '', b.guests ? esc(b.guests + ' ' + plural(b.guests, 'гость', 'гостя', 'гостей')) : ''].filter(Boolean).join(' · ');
        html += `<td class="cell"><button class="slot slot--booked" data-id="${esc(b.id)}">
          <span class="slot__name">${esc(b.name)}</span>
          ${meta ? `<span class="slot__meta">${meta}</span>` : ''}
          ${b.comment ? `<span class="slot__meta">${esc(b.comment)}</span>` : ''}
          ${Number(b.deposit) ? `<span class="chip">Задаток ${money(b.deposit)}</span>` : ''}
        </button></td>`;
      } else {
        html += `<td class="cell"><button class="slot slot--free" data-place="${esc(p.id)}" data-time="${t}">Свободно <span>+ бронь</span></button></td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  grid.innerHTML = html;
  grid.querySelectorAll('.slot--booked').forEach(el => el.onclick = () => openDialog(state.bookings.get(el.dataset.id)));
  grid.querySelectorAll('.slot--free').forEach(el => el.onclick = () => openDialog(null, { placeId: el.dataset.place, time: el.dataset.time, date }));
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
  const offset = (new Date(y, m, 1).getDay() + 6) % 7; // понедельник — первый
  const start = new Date(y, m, 1 - offset);
  const today = todayStr();

  const counts = new Map(), deps = new Map();
  let monthCount = 0, monthDep = 0;
  for (const b of state.bookings.values()) {
    counts.set(b.date, (counts.get(b.date) || 0) + 1);
    deps.set(b.date, (deps.get(b.date) || 0) + (Number(b.deposit) || 0));
    const d = parse(b.date);
    if (d.getFullYear() === y && d.getMonth() === m) { monthCount++; monthDep += Number(b.deposit) || 0; }
  }
  $('monthSummary').innerHTML = `<span>Броней за месяц: <b>${monthCount}</b></span>` + (monthDep ? `<span>Задатков: <b>${money(monthDep)}</b></span>` : '');

  let html = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => `<div class="cal__dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    if (i >= 35 && d.getMonth() !== m) break;
    const s = ymd(d), c = counts.get(s) || 0, dp = deps.get(s) || 0;
    const cls = ['cal__day', d.getMonth() !== m ? 'other' : '', s === today ? 'today' : ''].join(' ');
    html += `<button class="${cls}" data-date="${s}">
      <span class="cal__num">${d.getDate()}</span>
      ${c ? `<span class="cal__count">${c} ${plural(c, 'бронь', 'брони', 'броней')}</span>` : ''}
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

// Поиск по всем броням
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

// ================= Места и время =================
function renderPlaces() {
  const ul = $('placesList');
  ul.innerHTML = !state.places.length
    ? '<li class="slots-preview">Мест пока нет — добавьте первое ниже.</li>'
    : state.places.map((p, i) => `<li class="place" data-id="${esc(p.id)}">
        <input type="text" value="${esc(p.name)}" maxlength="40" aria-label="Название места">
        <button class="btn btn--icon" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Выше">↑</button>
        <button class="btn btn--icon" data-act="down" ${i === state.places.length - 1 ? 'disabled' : ''} aria-label="Ниже">↓</button>
        <button class="btn btn--danger" data-act="del">Удалить</button>
      </li>`).join('');

  ul.querySelectorAll('.place').forEach(li => {
    const id = li.dataset.id;
    const input = li.querySelector('input');
    input.onchange = () => {
      const name = input.value.trim();
      const p = state.places.find(x => x.id === id);
      if (!name || !p || name === p.name) { input.value = p ? p.name : ''; return; }
      write(() => updateDoc(doc(db, 'places', id), { name }));
    };
    li.querySelectorAll('button').forEach(btn => btn.onclick = () => {
      if (btn.dataset.act === 'del') return askDeletePlace(li, id);
      const i = state.places.findIndex(x => x.id === id);
      const j = btn.dataset.act === 'up' ? i - 1 : i + 1;
      const a = state.places[i], b = state.places[j];
      if (!a || !b) return;
      // если порядок совпадает (старые данные) — раздаём заново
      const oa = a.order === b.order ? j : b.order, ob = a.order === b.order ? i : a.order;
      write(async () => {
        await updateDoc(doc(db, 'places', a.id), { order: oa });
        await updateDoc(doc(db, 'places', b.id), { order: ob });
      });
    });
  });

  const opts = [];
  for (let m = 0; m < 24 * 60; m += 30) opts.push(toTime(m));
  const fill = (sel, val) => { sel.innerHTML = opts.map(t => `<option ${t === val ? 'selected' : ''}>${t}</option>`).join(''); };
  fill($('slotStart'), state.settings.start);
  fill($('slotEnd'), state.settings.end);
  $('slotStep').value = String(state.settings.step);
  $('slotsPreview').textContent = 'Строки сейчас: ' + slots().join(', ');
}

function askDeletePlace(li, id) {
  if (li.querySelector('.confirm')) return;
  const p = state.places.find(x => x.id === id);
  const future = [...state.bookings.values()].filter(b => b.placeId === id && b.date >= todayStr()).length;
  const box = document.createElement('div');
  box.className = 'confirm'; box.style.width = '100%';
  box.innerHTML = `Удалить «${esc(p.name)}»?${future ? ` На него есть брони (${future}) — они пропадут из таблицы.` : ''}<span class="spacer"></span><button class="btn" data-n>Нет</button><button class="btn btn--danger-solid" data-y>Удалить</button>`;
  li.appendChild(box);
  box.querySelector('[data-n]').onclick = () => box.remove();
  box.querySelector('[data-y]').onclick = () => write(() => deleteDoc(doc(db, 'places', id)));
}

$('addPlaceForm').onsubmit = e => {
  e.preventDefault();
  const name = $('newPlace').value.trim();
  if (!name) return;
  const order = state.places.reduce((m, p) => Math.max(m, p.order || 0), 0) + 1;
  write(async () => { await addDoc(collection(db, 'places'), { name, order }); $('newPlace').value = ''; });
};

$('slotsForm').onsubmit = e => {
  e.preventDefault();
  const s = { start: $('slotStart').value, end: $('slotEnd').value, step: Number($('slotStep').value) };
  if (toMin(s.end) < toMin(s.start)) { $('slotsPreview').textContent = 'Время «до» должно быть позже времени «с».'; return; }
  write(() => setDoc(doc(db, 'settings', 'main'), s));
};

// ================= Окно брони =================
attachPhoneMask($('fPhone'));
let editing = null;

function openDialog(b, slot) {
  editing = b ? { ...b } : { ...slot };
  const place = state.places.find(p => p.id === editing.placeId);
  $('dlgTitle').textContent = b ? 'Бронь' : 'Новая бронь';
  $('dlgSub').textContent = `${place ? place.name : 'Место удалено'} · ${fmtDay(editing.date)}, ${editing.time}`;
  $('fName').value = b?.name || '';
  $('fPhone').value = b?.phone || '';
  $('fGuests').value = b?.guests || '';
  $('fDeposit').value = b && Number(b.deposit) ? b.deposit : '';
  $('fComment').value = b?.comment || '';
  $('dlgError').hidden = true;
  $('dlgConfirm').hidden = true;
  $('dlgDelete').hidden = !b;
  $('dlg').showModal();
  setTimeout(() => $('fName').focus(), 30);
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
    updatedBy: auth.currentUser?.email || '',
  };
  // Одна бронь на одно место и время: id ячейки фиксированный
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
      ? 'Нет права менять данные. Проверьте правила Firestore (см. инструкцию).'
      : 'Не удалось сохранить. Проверьте интернет и попробуйте ещё раз.';
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; } else notice(msg, true);
  } finally { busy = false; }
}

// Открыть нужную вкладку по ссылке (#month, #places)
const startView = location.hash.replace('#', '');
if (['day', 'month', 'places'].includes(startView)) state.view = startView;
