/* =====================================================
   FocusFlow - アプリメインロジック (Firebase版)
   ===================================================== */

// Firebase 設定
const firebaseConfig = {
  apiKey: "AIzaSyCRg2HjKyWZeqh4wZuLevO8BSmNHpQ1kfI",
  authDomain: "focus-21fb0.firebaseapp.com",
  projectId: "focus-21fb0",
  storageBucket: "focus-21fb0.firebasestorage.app",
  messagingSenderId: "163433322038",
  appId: "1:163433322038:web:21a1059971bf414f6e6a97",
  measurementId: "G-VZBLWCK8XK"
};

// Firebase 初期化
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

let currentUser = null;
let currentTasks = []; // 現在のタスクリスト（メモリ保持用）

/* ---- 認証・初期化ロジック ---- */

// ログイン状態の監視
auth.onAuthStateChanged(async (user) => {
  const loginScreen = document.getElementById('login-screen');
  const appWrapper = document.getElementById('app-wrapper');

  if (user) {
    currentUser = user;
    console.log("Logged in as:", user.email);
    
    // ログイン成功: UI切り替え
    loginScreen.style.display = 'none';
    appWrapper.style.display = 'block';

    // ユーザー情報の初期化（Firestoreから名前を取得）
    await initUserProfile();

    // データの読み込みと移行チェック
    await syncTasks();
    
    // 通知スケジュールを再設定
    rescheduleAllNotifications();
  } else {
    currentUser = null;
    currentTasks = [];
    loginScreen.style.display = 'flex';
    appWrapper.style.display = 'none';
  }
});

/** ユーザープロフィールを初期化・取得する */
async function initUserProfile() {
  if (!currentUser) return;
  
  const userRef = db.collection('users').doc(currentUser.uid);
  const doc = await userRef.get();
  
  let displayName = currentUser.displayName || "ユーザー";
  
  if (doc.exists && doc.data().username) {
    displayName = doc.data().username;
  } else {
    // 初期値を保存しておく
    await userRef.set({ username: displayName }, { merge: true });
  }
  
  updateUserDisplay(displayName);
}

/** ユーザー名の表示を更新する */
function updateUserDisplay(name) {
  document.getElementById('user-display').textContent = `${name} さん`;
}

/** プロフィールモーダルを開く */
function openProfileModal() {
  if (!currentUser) return;
  const currentName = document.getElementById('user-display').textContent.replace(' さん', '');
  document.getElementById('profile-name-input').value = currentName;
  document.getElementById('profile-modal').classList.add('show');
}

/** プロフィールモーダルを閉じる */
function closeProfileModal() {
  document.getElementById('profile-modal').classList.remove('show');
}

/** プロフィールを保存する */
async function saveProfile() {
  const newName = document.getElementById('profile-name-input').value.trim();
  if (!newName || !currentUser) return;
  
  await db.collection('users').doc(currentUser.uid).set({ username: newName }, { merge: true });
  updateUserDisplay(newName);
  closeProfileModal();
  showBanner('👤 プロフィール更新', 'お名前を変更しました。');
}

// Googleログイン実行
async function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await auth.signInWithPopup(provider);
  } catch (error) {
    console.error("Login failed:", error);
    alert("ログインに失敗しました。");
  }
}

// ログアウト実行（必要ならデバッグ用に）
function logout() {
  auth.signOut();
}

// ボタンにイベント割り当て
document.getElementById('google-login-btn').addEventListener('click', signInWithGoogle);

/* ---- データ管理 (Firestore) ---- */

/** Firestoreと同期する */
async function syncTasks() {
  if (!currentUser) return;

  const docRef = db.collection('users').doc(currentUser.uid);
  const doc = await docRef.get();

  // 1. LocalStorageに古いデータがあるか確認（移行用）
  const localData = localStorage.getItem('focusflow_tasks');
  
  if (!doc.exists && localData) {
    // DBにデータがなく、ローカルにデータがある場合 -> 初回移行
    console.log("Migrating local data to Firestore...");
    const tasks = JSON.parse(localData);
    await docRef.set({ tasks: tasks });
    currentTasks = tasks;
    // 移行完了後はLocalデータを消すか、フラグを立てる（ここでは安全のため名前を変えて残す）
    localStorage.setItem('focusflow_migrated_backup', localData);
    localStorage.removeItem('focusflow_tasks');
  } else if (doc.exists) {
    // DBにデータがある場合
    currentTasks = doc.data().tasks || [];
  } else {
    // どちらも空の場合
    currentTasks = [];
  }

  renderCurrentTab();
}

/** 現在のタスクリストを取得（メモリから） */
function loadTasks() {
  return currentTasks;
}

/** タスクをFirestoreとメモリに保存する */
async function saveTasks(tasks) {
  currentTasks = tasks;
  if (currentUser) {
    await db.collection('users').doc(currentUser.uid).set({ tasks: tasks }, { merge: true });
  }
  renderCurrentTab();
}

/** 新しいタスクオブジェクトを生成する */
function createTask({ title, note = '', deadline = null, priority = 'mid', notifications = [] }) {
  return {
    id: crypto.randomUUID(),
    title,
    note,
    deadline,
    priority,
    notifications,
    completed: false,
    postponeCount: 0,
    postponeLog: [],
    createdAt: new Date().toISOString(),
  };
}

/* ---- 通知システム ---- */

/** 通知許可をリクエストする */
async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

/**
 * タスクの期限に応じてsetTimeoutで通知をスケジュールする
 * @param {object} task - タスクオブジェクト
 */
function scheduleNotifications(task) {
  if (!task.deadline || task.completed) return;

  const deadline = new Date(task.deadline);
  const now = new Date();

  // 通知タイミングの定義（ラベル→ミリ秒前）
  const NOTIF_MAP = {
    '3d':      3 * 24 * 60 * 60 * 1000,
    '1d':      1 * 24 * 60 * 60 * 1000,
    '3h':      3 * 60 * 60 * 1000,
    '1h':      1 * 60 * 60 * 1000,
    'morning': 0, // 当日朝9時（別途計算）
  };

  // 既存のタイマーをキャンセル
  if (window._notifTimers && window._notifTimers[task.id]) {
    window._notifTimers[task.id].forEach(clearTimeout);
  }
  if (!window._notifTimers) window._notifTimers = {};
  window._notifTimers[task.id] = [];

  task.notifications.forEach((key) => {
    let notifTime;

    if (key === 'morning') {
      // 期限当日の朝9時
      const morning = new Date(deadline);
      morning.setHours(9, 0, 0, 0);
      notifTime = morning;
    } else {
      notifTime = new Date(deadline.getTime() - NOTIF_MAP[key]);
    }

    const msUntil = notifTime.getTime() - now.getTime();
    if (msUntil <= 0) return; // 過去の通知はスキップ

    const timer = setTimeout(() => {
      fireNotification(task, key);
    }, msUntil);

    window._notifTimers[task.id].push(timer);
  });
}

/** ブラウザ通知を発火する */
function fireNotification(task, key) {
  if (Notification.permission !== 'granted') return;

  const LABELS = {
    '3d': '3日前', '1d': '前日', '3h': '3時間前', '1h': '1時間前', 'morning': '当日の朝'
  };

  const notif = new Notification(`⏰ ${task.title}`, {
    body: `期限まで${LABELS[key] || ''}です。忘れずに！`,
    icon: '/icons/icon-192.png',
    tag: `${task.id}-${key}`,
    requireInteraction: true,
  });

  notif.onclick = () => { window.focus(); notif.close(); };
}

/** 全タスクの通知をスケジュールし直す */
function rescheduleAllNotifications() {
  loadTasks().forEach(scheduleNotifications);
}

/* ---- 時間ユーティリティ ---- */

/** 残り時間を人間が読める文字列で返す */
function getDeadlineLabel(deadline) {
  if (!deadline) return null;
  const now = new Date();
  const dl = new Date(deadline);
  const diffMs = dl - now;
  
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(dl.getFullYear(), dl.getMonth(), dl.getDate());
  const diffDays = Math.round((target - today) / 86400000);

  if (diffMs < 0) return { text: '期限切れ', cls: 'deadline-urgent' };
  
  if (diffDays === 0) {
    const hh = String(dl.getHours()).padStart(2, '0');
    const mm = String(dl.getMinutes()).padStart(2, '0');
    // 時間が23:59なら時間未設定とみなす
    if (hh === '23' && mm === '59') {
      return { text: '今日', cls: diffMs < 0 ? 'deadline-urgent' : 'deadline-soon' };
    }
    return { text: `${hh}:${mm}`, cls: diffMs < 0 ? 'deadline-urgent' : 'deadline-soon' };
  }
  
  if (diffDays === 1) return { text: '明日', cls: 'deadline-soon' };
  if (diffDays === 2) return { text: '明後日', cls: 'deadline-ok' };
  return { text: `${diffDays}日後`, cls: 'deadline-ok' };
}

/** 今日のタスクかどうか判定する */
function isToday(task) {
  if (!task.deadline) return true; // 期限なし → 今日のタスク
  const today = new Date();
  const dl = new Date(task.deadline);
  return dl.toDateString() === today.toDateString() ||
    dl < new Date(today.setHours(0,0,0,0) + 86400000);
}

/** 今日完了したタスクかどうか判定する */
function isCompletedToday(task) {
  if (!task.completed || !task.completedAt) return false;
  const today = new Date();
  const compDate = new Date(task.completedAt);
  return compDate.toDateString() === today.toDateString();
}

/* ---- UI描画 ---- */

let currentTab = 'today';
let selectedPriority = 'mid';
let selectedNotifications = [];
let editingTaskId = null;
let postponingTaskId = null;

/** ホーム（今日）タブを描画する */
function renderToday() {
  const allTasks = loadTasks();
  
  // 今日の対象タスク：「未完了で今日が期限（または期限なし）」または「今日完了したタスク」
  const todayTasks = allTasks.filter(t => 
    (!t.completed && isToday(t)) || isCompletedToday(t)
  ).sort((a, b) => {
    const pOrder = { high: 0, mid: 1, low: 2 };
    if (pOrder[a.priority] !== pOrder[b.priority]) return pOrder[a.priority] - pOrder[b.priority];
    // 完了済みのものは一番下へ
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return 0;
  });

  // 進捗は「今日の対象タスク」全体から計算
  const done = todayTasks.filter(t => t.completed).length;
  const total = todayTasks.length;

  // 進捗バー更新
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-label').textContent = `${done} / ${total} 完了`;

  // タスクリスト描画
  const listEl = document.getElementById('today-task-list');
  if (todayTasks.length === 0) {
    if (total > 0 && done === total) {
      listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">🎉</div><p>今日のタスクはすべて完了しました！<br>履歴タブから確認できます。</p></div>`;
    } else {
      listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">🌟</div><p>今日のタスクはありません<br>上の入力欄からどんどん追加しよう！</p></div>`;
    }
    return;
  }

  listEl.innerHTML = todayTasks.map(task => renderTaskCard(task)).join('');
}

/** 履歴タブを描画する */
function renderHistory() {
  const allTasks = loadTasks();
  // 完了済みかつ「今日完了したものではない（昨日以前の）」タスク
  const completedTasks = allTasks.filter(t => t.completed && !isCompletedToday(t)).sort((a, b) => {
    // 完了日時の新しい順に並べる
    if (a.completedAt && b.completedAt) return new Date(b.completedAt) - new Date(a.completedAt);
    return b.id.localeCompare(a.id);
  });

  const listEl = document.getElementById('history-task-list');
  if (completedTasks.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">📚</div><p>完了済みのタスクはありません</p></div>`;
    return;
  }

  listEl.innerHTML = completedTasks.map(task => renderTaskCard(task)).join('');
}

/** スケジュールタブを描画する */
function renderSchedule() {
  const tasks = loadTasks().filter(t => !t.completed && t.deadline && !isToday(t));
  tasks.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

  // 日付でグルーピング
  const groups = {};
  tasks.forEach(task => {
    const dl = new Date(task.deadline);
    const key = dl.toDateString();
    if (!groups[key]) groups[key] = { label: formatDateLabel(dl), tasks: [] };
    groups[key].tasks.push(task);
  });

  const listEl = document.getElementById('schedule-list');
  if (Object.keys(groups).length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div><p>期限付きタスクがありません</p></div>`;
    return;
  }

  listEl.innerHTML = Object.values(groups).map(group => `
    <div class="date-group">
      <div class="date-group-label">📅 ${group.label}</div>
      ${group.tasks.map(task => renderTaskCard(task, true)).join('')}
    </div>
  `).join('');
}

/** 日付を読みやすい文字列にフォーマットする */
function formatDateLabel(date) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffD = Math.round((target - today) / 86400000);

  const wdays = ['日','月','火','水','木','金','土'];
  const base = `${date.getMonth()+1}月${date.getDate()}日（${wdays[date.getDay()]}）`;

  if (diffD === 0) return `今日 ${base}`;
  if (diffD === 1) return `明日 ${base}`;
  if (diffD < 0) return `期限切れ ${base}`;
  return base;
}

/** 優先度バッジのHTMLを返す */
function priorityBadge(priority) {
  const map = { high: { label: '高', cls: 'badge-high' }, mid: { label: '中', cls: 'badge-mid' }, low: { label: '低', cls: 'badge-low' } };
  const p = map[priority] || map.mid;
  return `<span class="priority-badge ${p.cls}">${p.label}</span>`;
}

/** タスクカードのHTMLを生成する */
function renderTaskCard(task, isSchedule = false) {
  const dl = task.deadline ? getDeadlineLabel(task.deadline) : null;
  const isOverdue = task.deadline && new Date(task.deadline) < new Date() && !task.completed;

  let timeHtml = '';
  if (isSchedule && task.deadline) {
    const d = new Date(task.deadline);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    // 23:59は未設定扱い
    if (hh !== '23' || mm !== '59') {
      timeHtml = `<span class="schedule-time">${hh}:${mm}</span>`;
    }
  }

  // アイコン定義
  const iconTrash = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;

  return `
    <div class="task-card ${task.completed ? 'completed' : ''} ${isOverdue ? 'overdue' : ''}"
         data-id="${task.id}" data-priority="${task.priority}"
         onclick="openEditModal('${task.id}')">
      <div class="task-card-top">
        <div class="task-check ${task.completed ? 'checked' : ''}"
             id="check-${task.id}"
             onclick="toggleComplete('${task.id}', event)">
          ${task.completed ? '✅' : '⚪'}
        </div>
        <div class="task-content">
          <div class="task-title-row">
            <div class="task-title">${escHtml(task.title)}</div>
            ${timeHtml}
          </div>
          ${task.note ? `<div class="task-note-snippet">${escHtml(task.note.substring(0, 30))}${task.note.length > 30 ? '...' : ''}</div>` : ''}
          <div class="task-meta">
            ${dl && !isSchedule ? `<span class="task-deadline ${dl.cls}">${dl.text}</span>` : ''}
            ${task.postponeCount > 0 ? `<span class="postpone-count">後回し×${task.postponeCount}</span>` : ''}
          </div>
        </div>
        <button class="delete-btn" onclick="deleteTask('${task.id}', event)" title="削除">
          ${iconTrash}
        </button>
      </div>
    </div>`;
}

/** HTMLエスケープ */
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ---- タスク操作 ---- */

/** タスクを完了/未完了トグルする */
function toggleComplete(id, event) {
  event.stopPropagation();
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  task.completed = !task.completed;
  
  // 完了した時間を記録する（未完了に戻した場合はクリア）
  task.completedAt = task.completed ? new Date().toISOString() : null;
  
  saveTasks(tasks);

  if (task.completed) {
    spawnConfetti(event.target);
    showBanner('🎉 完了！', `「${task.title}」を完了しました。お疲れ様！`);

    // 今日のタスクが全部完了したかチェック
    const allTasks = loadTasks();
    const todayTasks = allTasks.filter(isToday);
    if (todayTasks.length > 0 && todayTasks.every(t => t.completed)) {
      setTimeout(() => showCelebration(), 600);
    }
  }

  renderCurrentTab();
}

/* ---- 全タスク完了お祝い ---- */

/** お祝いオーバーレイを表示してパーティクルを起動する */
function showCelebration() {
  const overlay = document.getElementById('celebration-overlay');
  overlay.classList.add('show');

  // 絵文字を下から湧き上がらせ続ける
  startEmojiRise();

  // 花火を複数箇所で爆発させる
  const positions = [
    { x: '20%', y: '30%' }, { x: '80%', y: '20%' },
    { x: '50%', y: '50%' }, { x: '15%', y: '70%' },
    { x: '85%', y: '65%' }, { x: '40%', y: '15%' },
  ];
  positions.forEach((pos, i) => {
    setTimeout(() => launchFirework(pos.x, pos.y), i * 200);
  });
}

/** お祝いオーバーレイを閉じる */
function closeCelebration() {
  document.getElementById('celebration-overlay').classList.remove('show');
  document.getElementById('celebration-stars').innerHTML = '';
  document.getElementById('fireworks').innerHTML = '';
}

/**
 * 絵文字を画面下からランダムな位置・速度で1個ずつ連続スポーンし、
 * オーバーレイが表示されている間ループし続ける
 */
function startEmojiRise() {
  const emojis = ['🎉','⭐','✨','💫','🌟','🎊','🔥','🦋','🌈','🎈','💜','💛','💚','❤️','🥳','👏','🎆','💥'];
  const container = document.getElementById('celebration-stars');
  container.innerHTML = '';

  function spawnOne() {
    if (!document.getElementById('celebration-overlay').classList.contains('show')) return;

    const el = document.createElement('div');
    el.className = 'star-particle';
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    const duration = 2.5 + Math.random() * 3;
    el.style.cssText = `
      left: ${Math.random() * 100}%;
      font-size: ${1 + Math.random() * 2}rem;
      animation-duration: ${duration}s;
      animation-delay: 0s;
    `;
    container.appendChild(el);
    el.addEventListener('animationend', () => el.remove());

    // 次の1個を短いランダム間隔で発射（5倍密度）
    setTimeout(spawnOne, 16 + Math.random() * 24);
  }

  spawnOne();
}

/** タスクを削除する */
function deleteTask(id, event) {
  event.stopPropagation();
  const tasks = loadTasks().filter(t => t.id !== id);
  saveTasks(tasks);
  renderCurrentTab();
}

/* ---- タスク登録モーダル ---- */

/** 詳細登録モーダルを開く */
function openAddModal(prefillTitle = '') {
  editingTaskId = null;
  selectedPriority = 'mid';
  selectedNotifications = ['1d', 'morning'];

  document.getElementById('modal-title-text').textContent = '新しいタスク';
  document.getElementById('task-title-input').value = prefillTitle;
  document.getElementById('task-note-input').value = '';
  document.getElementById('task-date-input').value = '';
  document.getElementById('task-time-input').value = '';
  updatePriorityUI();
  updateNotifUI();

  document.getElementById('edit-postpone-btn').style.display = 'none'; // 新規時は非表示

  document.getElementById('add-modal').classList.add('show');
  setTimeout(() => document.getElementById('task-title-input').focus(), 350);
}

/** タスク詳細ポップアップを開く（カードクリック時） */
function openTaskDetail(id, event) {
  if (event) event.stopPropagation();
  const task = loadTasks().find(t => t.id === id);
  if (!task) return;

  // 詳細ポップアップに内容を埋め込む
  const dl = task.deadline ? getDeadlineLabel(task.deadline) : null;
  const wdays = ['日','月','火','水','木','金','土'];
  let deadlineStr = '未設定';
  if (task.deadline) {
    const d = new Date(task.deadline);
    deadlineStr = `${d.getMonth()+1}月${d.getDate()}日（${wdays[d.getDay()]}）${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
  const priorityLabel = { high: '🔴 高', mid: '🟡 中', low: '🟢 低' }[task.priority] || '🟡 中';

  document.getElementById('detail-task-title').textContent = task.title;
  document.getElementById('detail-task-note').textContent = task.note || '';
  document.getElementById('detail-task-note').style.display = task.note ? 'block' : 'none';
  const dlEl = document.getElementById('detail-task-deadline');
  dlEl.textContent = deadlineStr;
  dlEl.className = 'detail-info-value' + (dl ? ' ' + dl.cls : '');
  document.getElementById('detail-task-priority').textContent = priorityLabel;
  document.getElementById('detail-postpone-count').textContent =
    task.postponeCount > 0 ? `後回し ${task.postponeCount} 回` : '';

  // ボタン設定
  document.getElementById('detail-edit-btn').onclick = () => { closeTaskDetail(); openEditModal(id); };
  document.getElementById('detail-postpone-btn').style.display = task.completed ? 'none' : 'block';
  document.getElementById('detail-postpone-btn').onclick = () => { closeTaskDetail(); openPostpone(id, null); };

  document.getElementById('detail-modal').classList.add('show');
}

/** 詳細ポップアップを閉じる */
function closeTaskDetail() {
  document.getElementById('detail-modal').classList.remove('show');
}

/** 編集モーダルを開く（詳細ポップアップの「編集」から） */
function openEditModal(id) {
  const task = loadTasks().find(t => t.id === id);
  if (!task) return;

  editingTaskId = id;
  selectedPriority = task.priority;
  selectedNotifications = [...(task.notifications || [])];

  document.getElementById('modal-title-text').textContent = 'タスクを編集';
  document.getElementById('task-title-input').value = task.title;
  document.getElementById('task-note-input').value = task.note || '';
  
  if (task.deadline) {
    const d = new Date(task.deadline);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    document.getElementById('task-date-input').value = `${yyyy}-${mm}-${dd}`;
    if (hh === '23' && mins === '59') {
      document.getElementById('task-time-input').value = '';
    } else {
      document.getElementById('task-time-input').value = `${hh}:${mins}`;
    }
  } else {
    document.getElementById('task-date-input').value = '';
    document.getElementById('task-time-input').value = '';
  }

  updatePriorityUI();
  updateNotifUI();

  document.getElementById('edit-postpone-btn').style.display = 'block'; // 編集時は表示

  document.getElementById('add-modal').classList.add('show');
}

/** 編集画面から後回しにする */
function handleEditPostpone() {
  if (!editingTaskId) return;
  closeAddModal();
  openPostpone(editingTaskId, null);
}

/** モーダルを閉じる */
function closeAddModal() {
  document.getElementById('add-modal').classList.remove('show');
}

/** プルダウンの開閉 */
function toggleNotifDropdown() {
  document.getElementById('notif-select-wrapper').classList.toggle('open');
}

/** プルダウン以外をクリックしたら閉じる処理 */
document.addEventListener('click', (e) => {
  const wrapper = document.getElementById('notif-select-wrapper');
  if (wrapper && wrapper.classList.contains('open') && !wrapper.contains(e.target)) {
    wrapper.classList.remove('open');
  }
});

/** UIから通知設定配列を読み取り表示を更新する */
function updateNotifDisplay() {
  const checkboxes = document.querySelectorAll('.notif-checkbox');
  const selected = [];
  checkboxes.forEach(cb => {
    if (cb.checked) {
      // 親ラベルのテキストを取得
      selected.push(cb.parentElement.textContent.trim());
    }
  });

  const displayText = document.getElementById('notif-display-text');
  if (selected.length === 0) {
    displayText.textContent = '通知なし';
  } else if (selected.length <= 2) {
    displayText.textContent = selected.join(', ');
  } else {
    displayText.textContent = `${selected[0]} 他${selected.length - 1}件`;
  }
}

/** UIに配列の状態を反映させる */
function updateNotifUI() {
  const checkboxes = document.querySelectorAll('.notif-checkbox');
  checkboxes.forEach(cb => {
    cb.checked = selectedNotifications.includes(cb.value);
  });
  updateNotifDisplay();
}

/** 優先度UIを更新する */
function updatePriorityUI() {
  document.querySelectorAll('.priority-option').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.value === selectedPriority);
  });
}

/** タスクを保存する */
function saveTask() {
  const title = document.getElementById('task-title-input').value.trim();
  const note = document.getElementById('task-note-input').value.trim();
  const dateRaw = document.getElementById('task-date-input').value;
  const timeRaw = document.getElementById('task-time-input').value;

  if (!title) {
    document.getElementById('task-title-input').focus();
    document.getElementById('task-title-input').style.borderColor = 'var(--priority-high)';
    setTimeout(() => document.getElementById('task-title-input').style.borderColor = '', 1500);
    return;
  }

  let deadlineISO = null;
  if (dateRaw) {
    if (timeRaw) {
      deadlineISO = new Date(`${dateRaw}T${timeRaw}`).toISOString();
    } else {
      deadlineISO = new Date(`${dateRaw}T23:59:00`).toISOString();
    }
  }

  // UIから現在選択されている通知設定を取得
  const checkboxes = document.querySelectorAll('.notif-checkbox');
  const newNotifications = [];
  checkboxes.forEach(cb => {
    if (cb.checked) newNotifications.push(cb.value);
  });

  const tasks = loadTasks();

  if (editingTaskId) {
    // 編集モード
    const task = tasks.find(t => t.id === editingTaskId);
    if (task) {
      task.title = title;
      task.note = note;
      task.deadline = deadlineISO;
      task.priority = selectedPriority;
      task.notifications = newNotifications;
      scheduleNotifications(task);
    }
  } else {
    // 新規作成
    const task = createTask({ title, note, deadline: deadlineISO, priority: selectedPriority, notifications: newNotifications });
    tasks.unshift(task);
    scheduleNotifications(task);
  }

  saveTasks(tasks);
  closeAddModal();
  renderCurrentTab();
}

/* ---- 後回しモーダル ---- */

/** 後回しモーダルを開く */
function openPostpone(id, event) {
  if (event) event.stopPropagation();
  postponingTaskId = id;
  const task = loadTasks().find(t => t.id === id);
  if (!task) return;
  document.getElementById('postpone-task-name').textContent = task.title;
  document.getElementById('postpone-modal').classList.add('show');
}

/** 後回しモーダルを閉じる */
function closePostponeModal() {
  document.getElementById('postpone-modal').classList.remove('show');
}

/** 後回し処理を実行する */
function doPostpone(days) {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === postponingTaskId);
  if (!task) return;

  // 後回しカウントを増やす
  task.postponeCount = (task.postponeCount || 0) + 1;
  task.postponeLog.push({ date: new Date().toISOString(), days });

  // 期限を延長する
  if (task.deadline) {
    const dl = new Date(task.deadline);
    dl.setDate(dl.getDate() + days);
    task.deadline = dl.toISOString();
  } else {
    // 期限がなかった場合は今日からdays日後に設定
    const dl = new Date();
    dl.setDate(dl.getDate() + days);
    dl.setHours(23, 59, 0, 0);
    task.deadline = dl.toISOString();
  }

  scheduleNotifications(task);
  saveTasks(tasks);
  closePostponeModal();
  renderCurrentTab();

  const msgs = [
    '大丈夫！また後で取り組もう😊',
    'その気持ち、わかるよ。無理せずね💪',
    '少し休憩も大事！また頑張ろう✨',
  ];
  showBanner('⏰ 後回しにしました', msgs[task.postponeCount % msgs.length]);
}

/* ---- クイック入力 ---- */

/** クイック入力フォームの送信処理 */
function handleQuickAdd(event) {
  event.preventDefault();
  const input = document.getElementById('quick-input');
  const title = input.value.trim();
  if (!title) return;

  // 時間入力の取得（任意）
  const timeVal = document.getElementById('quick-time-input').value; // "HH:MM" or ""
  const notify1h = document.getElementById('quick-notif-1h').checked;

  let deadline = null;
  if (timeVal) {
    // 今日の日付に指定時刻をセットしてdeadlineを生成
    const now = new Date();
    const [hh, mm] = timeVal.split(':').map(Number);
    const dl = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0);
    deadline = dl.toISOString();
  }

  // 通知設定: 時間が指定されていて「1時間前通知」にチェックがある場合のみ有効
  const notifications = (deadline && notify1h) ? ['1h'] : [];

  const tasks = loadTasks();
  const task = createTask({ title, deadline, notifications });
  tasks.unshift(task);
  saveTasks(tasks);
  scheduleNotifications(task);

  // 入力リセット
  input.value = '';
  renderCurrentTab();
  showBanner('✅ 追加しました', `「${title}」を今日のリストに追加！`);
}

/* ---- タブ切り替え ---- */

/** タブを切り替える */
function switchTab(tabId) {
  currentTab = tabId;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

  document.getElementById(`tab-btn-${tabId}`).classList.add('active');
  document.getElementById(`tab-${tabId}`).classList.add('active');

  renderCurrentTab();
}

/** 現在のタブを描画する */
function renderCurrentTab() {
  if (currentTab === 'today') renderToday();
  else if (currentTab === 'history') renderHistory();
  else if (currentTab === 'schedule') renderSchedule();
}

/* ---- 通知バナー ---- */

let bannerTimer = null;

/** インアプリ通知バナーを表示する */
function showBanner(title, body) {
  const banner = document.getElementById('notif-banner');
  if (!banner) return; // バナーUIは削除されたためスキップ
  document.getElementById('banner-title').textContent = title;
  document.getElementById('banner-body').textContent = body;
  banner.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => banner.classList.remove('show'), 3500);
}

/* ---- 紙吹雪エフェクト ---- */

/** タスク完了時に紙吹雪を表示する */
function spawnConfetti(origin) {
  const colors = ['#7c6cf0','#5b8af0','#f06292','#ffa726','#66bb6a'];
  const rect = origin.getBoundingClientRect();
  const container = document.getElementById('confetti-container');

  for (let i = 0; i < 16; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.cssText = `
      left: ${rect.left + Math.random() * 40 - 20}px;
      top: ${rect.top}px;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      animation-delay: ${Math.random() * 0.2}s;
      transform: rotate(${Math.random() * 360}deg);
    `;
    container.appendChild(piece);
    setTimeout(() => piece.remove(), 1000);
  }
}

/* ---- Service Worker登録 ---- */

/** Service Workerを登録してPWA機能を有効化する */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    console.log('Service Worker 登録成功:', reg.scope);

    // バックグラウンドから CHECK_TASKS メッセージを受け取ったら通知確認
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'CHECK_TASKS') {
        checkUpcomingTasks();
      }
    });
  } catch (err) {
    console.warn('Service Worker 登録失敗:', err);
  }
}

/** 期限が近いタスクをチェックして通知する */
function checkUpcomingTasks() {
  const tasks = loadTasks();
  const now = new Date();

  tasks.filter(t => !t.completed && t.deadline).forEach(task => {
    const dl = new Date(task.deadline);
    const diffH = (dl - now) / (1000 * 60 * 60);
    if (diffH > 0 && diffH <= 1) {
      fireNotification(task, '1h');
    }
  });
}

/* ---- 日付表示の更新 ---- */

/** ヘッダーの今日の日付表示を更新する */
function updateDateDisplay() {
  const now = new Date();
  const wdays = ['日曜日','月曜日','火曜日','水曜日','木曜日','金曜日','土曜日'];
  document.getElementById('date-label').textContent =
    `${now.getMonth()+1}月${now.getDate()}日 ${wdays[now.getDay()]}`;
  document.getElementById('date-today').textContent =
    `${now.getFullYear()}年`;
}

/* ---- 初期化 ---- */

/** アプリを初期化する */
async function init() {
  updateDateDisplay();

  // 通知許可をリクエスト
  await requestNotificationPermission();

  // Service Worker登録
  await registerServiceWorker();

  // 1分ごとに期限チェック（表示更新）
  setInterval(renderCurrentTab, 60 * 1000);

  // イベントリスナーを設定
  setupEventListeners();
}

/** イベントリスナーをまとめて設定する */
function setupEventListeners() {
  // クイック追加フォーム
  document.getElementById('quick-add-form').addEventListener('submit', handleQuickAdd);

  // 優先度ボタン
  document.querySelectorAll('.priority-option').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedPriority = btn.dataset.value;
      updatePriorityUI();
    });
  });

  // 通知チェックボックス
  document.querySelectorAll('.notif-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!selectedNotifications.includes(cb.value)) selectedNotifications.push(cb.value);
      } else {
        selectedNotifications = selectedNotifications.filter(v => v !== cb.value);
      }
    });
  });

  // モーダルの背景クリックで閉じる
  document.getElementById('add-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAddModal();
  });
  document.getElementById('postpone-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePostponeModal();
  });
  document.getElementById('detail-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeTaskDetail();
  });
  document.getElementById('profile-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeProfileModal();
  });
}

// アプリ起動
document.addEventListener('DOMContentLoaded', init);
