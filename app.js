const form = document.querySelector('#pds-form');
const dateInput = document.querySelector('#date');
const statusEl = document.querySelector('#status');
const saveButton = document.querySelector('#save-button');
const refreshButton = document.querySelector('#refresh-button');
const historyList = document.querySelector('#history-list');
const template = document.querySelector('#entry-template');
const accessWrap = document.querySelector('#access-wrap');
const accessKeyInput = document.querySelector('#access-key');
const installButton = document.querySelector('#install-button');
const iosInstallDialog = document.querySelector('#ios-install-dialog');
const closeInstallDialog = document.querySelector('#close-install-dialog');
const greetingEl = document.querySelector('#greeting');
const todayLabel = document.querySelector('#today-label');
const monthLabel = document.querySelector('#month-label');
const weekStrip = document.querySelector('#week-strip');
const prevWeek = document.querySelector('#prev-week');
const nextWeek = document.querySelector('#next-week');
let deferredInstallPrompt = null;

function localToday() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function parseLocalDate(value) {
  return new Date(`${value}T00:00:00`);
}

function toLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function setGreeting() {
  const hour = new Date().getHours();
  greetingEl.textContent = hour < 12 ? 'Good morning,' : hour < 18 ? 'Good afternoon,' : 'Good evening,';
}

function updateDateUI(value) {
  const selected = parseLocalDate(value);
  const today = localToday();
  todayLabel.textContent = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(selected);
  monthLabel.textContent = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(selected);

  const weekStart = new Date(selected);
  weekStart.setDate(selected.getDate() - selected.getDay());
  const weekdayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  weekStrip.innerHTML = '';

  weekdayNames.forEach((name, index) => {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + index);
    const valueString = toLocalDateString(date);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'day-button';
    button.setAttribute('aria-label', `${name} ${date.getDate()}일`);
    if (valueString === today) button.classList.add('is-today');
    if (valueString === value) button.classList.add('is-selected');
    button.innerHTML = `<span class="weekday">${name}</span><span class="day-number">${date.getDate()}</span>`;
    button.addEventListener('click', () => {
      dateInput.value = valueString;
      updateDateUI(valueString);
    });
    weekStrip.appendChild(button);
  });
}

function shiftSelectedDate(days) {
  const date = parseLocalDate(dateInput.value || localToday());
  date.setDate(date.getDate() + days);
  dateInput.value = toLocalDateString(date);
  updateDateUI(dateInput.value);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function getAccessKey() {
  return accessKeyInput.value || sessionStorage.getItem('pdsAccessKey') || '';
}

function setStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function authHeaders() {
  const key = getAccessKey();
  return key ? { 'x-pds-access-key': key } : {};
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && data.code === 'ACCESS_KEY_REQUIRED') accessWrap.hidden = false;
  if (!response.ok) {
    throw Object.assign(new Error(data.message || '요청을 처리하지 못했습니다.'), {
      status: response.status,
      data,
    });
  }
  return data;
}

function displayDate(value) {
  if (!value) return '날짜 없음';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(parseLocalDate(value));
}

function renderEntries(entries) {
  historyList.innerHTML = '';
  if (!entries.length) {
    historyList.innerHTML = '<p class="empty-state">아직 저장된 회고가 없습니다. 오늘의 첫 기록을 남겨보세요.</p>';
    return;
  }

  entries.forEach((entry) => {
    const node = template.content.cloneNode(true);
    const time = node.querySelector('.entry-date');
    time.textContent = displayDate(entry.date) || entry.title || '날짜 없음';
    time.dateTime = entry.date || '';
    node.querySelector('.entry-mood').textContent = entry.mood || '기분 미기록';
    node.querySelector('.entry-plan').textContent = entry.plan || '—';
    node.querySelector('.entry-do').textContent = entry.do || '—';
    node.querySelector('.entry-see').textContent = entry.see || '—';

    const tags = node.querySelector('.entry-tags');
    (entry.tags || []).forEach((tag) => {
      const chip = document.createElement('span');
      chip.textContent = tag;
      tags.appendChild(chip);
    });

    const link = node.querySelector('.entry-link');
    link.href = entry.url || '#';
    if (!entry.url) link.hidden = true;
    historyList.appendChild(node);
  });
}

async function loadEntries() {
  historyList.innerHTML = '<p class="empty-state">기록을 불러오는 중입니다.</p>';
  try {
    const data = await api('/api/entries', { method: 'GET' });
    accessWrap.hidden = !data.accessKeyRequired;
    renderEntries(data.entries || []);
  } catch (error) {
    if (error.status === 503) {
      historyList.innerHTML = `<p class="empty-state">${error.message}</p>`;
    } else if (error.status === 401) {
      historyList.innerHTML = '<p class="empty-state">접근 키를 입력한 뒤 새로고침을 눌러주세요.</p>';
    } else {
      historyList.innerHTML = `<p class="empty-state">${error.message}</p>`;
    }
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const mood = document.querySelector('input[name="mood"]:checked')?.value || '';
  const tags = [...document.querySelectorAll('#tag-row input:checked')].map((el) => el.value);
  const payload = {
    date: dateInput.value,
    plan: document.querySelector('#plan').value.trim(),
    do: document.querySelector('#do').value.trim(),
    see: document.querySelector('#see').value.trim(),
    mood,
    tags,
  };

  if (!payload.date) return setStatus('날짜를 선택해주세요.', 'error');
  if (!payload.plan && !payload.do && !payload.see) {
    return setStatus('Plan, Do, See 중 하나 이상 기록해주세요.', 'error');
  }

  const key = getAccessKey();
  if (key) sessionStorage.setItem('pdsAccessKey', key);
  saveButton.disabled = true;
  setStatus('Notion에 저장 중…');

  try {
    const result = await api('/api/entries', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setStatus(result.updated ? '이 날짜의 회고를 업데이트했습니다.' : '오늘의 회고를 저장했습니다.', 'success');
    if ('vibrate' in navigator) navigator.vibrate(25);
    await loadEntries();
  } catch (error) {
    if (error.status === 401) setStatus('접근 키가 필요하거나 올바르지 않습니다.', 'error');
    else setStatus(error.message, 'error');
  } finally {
    saveButton.disabled = false;
  }
});

refreshButton.addEventListener('click', () => {
  const key = getAccessKey();
  if (key) sessionStorage.setItem('pdsAccessKey', key);
  loadEntries();
});

accessKeyInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  sessionStorage.setItem('pdsAccessKey', accessKeyInput.value);
  loadEntries();
});

prevWeek.addEventListener('click', () => shiftSelectedDate(-7));
nextWeek.addEventListener('click', () => shiftSelectedDate(7));
dateInput.addEventListener('change', () => updateDateUI(dateInput.value));

if (!isStandalone() && isIOS()) {
  installButton.hidden = false;
  installButton.setAttribute('aria-label', '홈 화면에 추가');
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (!isStandalone()) {
    installButton.hidden = false;
    installButton.setAttribute('aria-label', '앱 설치');
  }
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  installButton.hidden = true;
});

installButton.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => null);
    deferredInstallPrompt = null;
    installButton.hidden = true;
    return;
  }
  if (isIOS()) iosInstallDialog.showModal();
});

closeInstallDialog.addEventListener('click', () => iosInstallDialog.close());
iosInstallDialog.addEventListener('click', (event) => {
  if (event.target === iosInstallDialog) iosInstallDialog.close();
});

document.querySelectorAll('textarea').forEach((textarea) => {
  const resize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 340)}px`;
  };
  textarea.addEventListener('input', resize);
  textarea.addEventListener('focus', () => {
    setTimeout(() => textarea.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120);
  });
});

setGreeting();
dateInput.value = localToday();
updateDateUI(dateInput.value);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

loadEntries();
