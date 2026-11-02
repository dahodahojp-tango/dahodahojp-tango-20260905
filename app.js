/*
  iPhone用単語帳

  GitHubに置くCSV:
  english.csv
  guide.csv
  infotech.csv

  各CSVの1行目:
  ID,問題,答え
*/

const BOOKS = [
  { key: "english", label: "英語", csv: "english.csv" },
  { key: "guide", label: "案内人", csv: "guide.csv" },
  { key: "infotech", label: "情報", csv: "infotech.csv" }
];

const DB_NAME = "WordbookDB";
const DB_VERSION = 1;
const STORE_NAME = "cards";
const RATE_STORAGE_KEY = "wordbookQuestionRate";
const DEFAULT_QUESTION_RATE = 5;
const MIN_COUNT_STORAGE_KEY = "wordbookMinimumCount";
const DEFAULT_MINIMUM_COUNT = 3;
const FONT_SIZE_STORAGE_KEY = "wordbookFontSize";

let db;
let currentBook = null;
let currentCard = null;
let showingAnswer = false;
let fontSize = 34;
let touchStartX = null;
let touchStartY = null;
let questionRate = DEFAULT_QUESTION_RATE;
let minimumCount = DEFAULT_MINIMUM_COUNT;

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  loadFontSize();
  db = await openDB();
  loadQuestionRate();
  loadMinimumCount();
  buildHomeButtons();
  buildDialogButtons();
  bindEvents();
  setupGithubSync();
  await refreshHomeCounts();
});

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("book", "book", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function makeKey(book, id) {
  return `${book}:${String(id).trim()}`;
}

function buildHomeButtons() {
  const box = $("bookButtons");
  box.innerHTML = "";

  for (const book of BOOKS) {
    const btn = document.createElement("button");
    btn.className = "book-button";
    btn.dataset.book = book.key;
    btn.innerHTML = `${escapeHtml(book.label)}<small id="count-${book.key}">0問</small>`;
    btn.addEventListener("click", () => startStudy(book.key));
    box.appendChild(btn);
  }
}

function buildDialogButtons() {
  $("importChoices").innerHTML = "";
  $("resetChoices").innerHTML = "";

  for (const book of BOOKS) {
    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.textContent = `${book.label}を取り込む`;
    importBtn.addEventListener("click", async () => {
      $("importDialog").close();
      await importCsv(book.key);
    });
    $("importChoices").appendChild(importBtn);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.textContent = `${book.label}を初期化`;
    resetBtn.addEventListener("click", async () => {
      $("resetDialog").close();
      if (confirm(`${book.label}を完全に初期化しますか？\n学習履歴と削除済み記録も消えます。`)) {
        await resetBook(book.key);
      }
    });
    $("resetChoices").appendChild(resetBtn);
  }
}

function bindEvents() {
  $("importButton").addEventListener("click", () => $("importDialog").showModal());
  $("resetButton").addEventListener("click", () => $("resetDialog").showModal());

  $("questionRateSelect").addEventListener("change", (e) => {
    questionRate = Math.max(1, Math.min(10, Number(e.target.value) || DEFAULT_QUESTION_RATE));
    localStorage.setItem(RATE_STORAGE_KEY, String(questionRate));
  });

  $("minimumCountSelect").addEventListener("change", (e) => {
    minimumCount = Math.max(0, Math.min(20, Number(e.target.value) || DEFAULT_MINIMUM_COUNT));
    localStorage.setItem(MIN_COUNT_STORAGE_KEY, String(minimumCount));
  });

  $("resetAllButton").addEventListener("click", async (e) => {
    e.preventDefault();
    $("resetDialog").close();
    if (confirm("全単語帳を完全に初期化しますか？\n学習履歴と削除済み記録もすべて消えます。")) {
      await resetAll();
    }
  });

  $("importantButton").addEventListener("click", async () => {
    if (!currentCard) return;
    currentCard.important = !currentCard.important;
    await putCard(currentCard);
    updateImportantButton();
    updateImportantIndicator();
  });

  $("topButton").addEventListener("click", goHome);

  $("correctButton").addEventListener("click", async () => {
    if (!currentCard) return;
    currentCard.shownCount += 1;
    currentCard.correctCount += 1;
    await putCard(currentCard);
    await nextCard();
  });

  $("wrongButton").addEventListener("click", async () => {
    if (!currentCard) return;
    currentCard.shownCount += 1;
    await putCard(currentCard);
    await nextCard();
  });

  $("deleteButton").addEventListener("click", async () => {
    if (!currentCard) return;
    if (!confirm("この問題を削除しますか？\n再取込しても復活しません。")) return;

    currentCard.deleted = true;
    currentCard.syncedDelete = false;
    await putCard(currentCard);
    await nextCard();
  });

  $("fontUpButton").addEventListener("click", () => changeFont(2));
  $("fontDownButton").addEventListener("click", () => changeFont(-2));

  $("card").addEventListener("click", () => toggleSide());

  $("card").addEventListener("touchstart", (e) => {
    const t = e.changedTouches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
  }, { passive: true });

  $("card").addEventListener("touchend", (e) => {
    if (touchStartX === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;

    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) {
      e.preventDefault();
      toggleSide();
    }
    touchStartX = null;
    touchStartY = null;
  }, { passive: false });
}

async function startStudy(bookKey) {
  currentBook = BOOKS.find(b => b.key === bookKey);
  if (!currentBook) return;

  const active = await getActiveCards(bookKey);
  if (active.length === 0) {
    setHomeMessage(`${currentBook.label}のデータがありません。「データ取込」から読み込んでください。`);
    return;
  }

  $("homeScreen").classList.remove("active");
  $("studyScreen").classList.add("active");
  await nextCard();
}

function goHome() {
  currentBook = null;
  currentCard = null;
  showingAnswer = false;
  $("studyScreen").classList.remove("active");
  $("homeScreen").classList.add("active");
  refreshHomeCounts();
}

async function nextCard() {
  if (!currentBook) return;

  const cards = await getActiveCards(currentBook.key);
  if (cards.length === 0) {
    currentCard = null;
    $("cardText").textContent = "問題がありません";
    $("progressText").textContent = "0 / 0";
    return;
  }

  currentCard = chooseCard(cards);
  showingAnswer = false;
  renderCard(cards.length);
}

/*
  出題ルール:
  1. 出題回数0回の問題があれば、その中からランダム
  2. なければ出題回数1～3回の問題からランダム
  3. それもなければ、正解率が低いほど出やすい重み付きランダム
*/
function chooseCard(cards) {
  // 出題率Nとは、正解率0%の問題を正解率100%の問題のN倍出しやすくする設定。
  // 出題回数が「最低回数」以下、および「重要問題」は、正解率0%と同じ重みにする。
  const weights = cards.map(c => {
    let effectiveAccuracy = c.shownCount > 0 ? c.correctCount / c.shownCount : 0;

    if (c.shownCount <= minimumCount || c.important) {
      effectiveAccuracy = 0;
    }

    // 正解率0% -> questionRate、正解率100% -> 1。途中は直線的に補間。
    return 1 + (questionRate - 1) * (1 - effectiveAccuracy);
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;

  for (let i = 0; i < cards.length; i++) {
    r -= weights[i];
    if (r <= 0) return cards[i];
  }
  return cards[cards.length - 1];
}

function randomOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function renderCard(total) {
  if (!currentCard) return;

  $("cardText").textContent = showingAnswer ? currentCard.answer : currentCard.question;

  const accuracy = currentCard.shownCount
    ? Math.round((currentCard.correctCount / currentCard.shownCount) * 100)
    : 0;

  $("progressText").textContent =
    `ID ${currentCard.id}　出題 ${currentCard.shownCount}回　正解率 ${accuracy}%　全${total}問`;

  updateImportantButton();
  updateImportantIndicator();
}

function toggleSide() {
  if (!currentCard) return;
  showingAnswer = !showingAnswer;
  getActiveCards(currentBook.key).then(cards => renderCard(cards.length));
}

function loadFontSize() {
  const saved = Number(localStorage.getItem(FONT_SIZE_STORAGE_KEY));
  if (Number.isFinite(saved) && saved >= 20 && saved <= 60) {
    fontSize = saved;
  }
  document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
}

function changeFont(delta) {
  fontSize = Math.max(20, Math.min(60, fontSize + delta));
  document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
  localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSize));
}

async function importCsv(bookKey) {
  const book = BOOKS.find(b => b.key === bookKey);
  if (!book) return;

  try {
    setHomeMessage(`${book.label}を読み込んでいます…`);

    const response = await fetch(`${book.csv}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`CSV取得失敗: ${response.status}`);

    const text = await response.text();
    const rows = parseCsv(text);

    if (rows.length < 2) throw new Error("CSVにデータがありません。");

    // CSVは列位置を固定して読む:
    // A列=ID、B列=問題、C列=答え
    // 1行目は見出しとして読み飛ばす。
    // Excel由来のBOMや見えない文字が見出しに混ざっても影響しないようにする。
    const idCol = 0;
    const qCol = 1;
    const aCol = 2;

    if (!rows[0] || rows[0].length < 3) {
      throw new Error("CSVは A列=ID、B列=問題、C列=答え の3列にしてください。");
    }

    let added = 0;
    let skipped = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const id = (row[idCol] ?? "").trim();
      const question = (row[qCol] ?? "").trim();
      const answer = (row[aCol] ?? "").trim();

      if (!id || (!question && !answer)) continue;

      const key = makeKey(bookKey, id);
      const existing = await getCard(key);

      if (existing) {
        skipped++;
        continue;
      }

      await putCard({
        key,
        book: bookKey,
        id,
        question,
        answer,
        shownCount: 0,
        correctCount: 0,
        deleted: false,
        important: false
      });

      added++;
    }

    await refreshHomeCounts();
    setHomeMessage(`${book.label}: ${added}件追加、${skipped}件スキップしました。`);
  } catch (err) {
    console.error(err);
    setHomeMessage(`取込エラー: ${err.message}`);
  }
}

function loadQuestionRate() {
  const saved = Number(localStorage.getItem(RATE_STORAGE_KEY));
  questionRate = Number.isInteger(saved) && saved >= 1 && saved <= 10
    ? saved
    : DEFAULT_QUESTION_RATE;

  const select = $("questionRateSelect");
  if (select) select.value = String(questionRate);
}

function loadMinimumCount() {
  const saved = Number(localStorage.getItem(MIN_COUNT_STORAGE_KEY));
  minimumCount = Number.isInteger(saved) && saved >= 0 && saved <= 20
    ? saved
    : DEFAULT_MINIMUM_COUNT;

  const select = $("minimumCountSelect");
  if (select) select.value = String(minimumCount);
}

function updateImportantButton() {
  const button = $("importantButton");
  if (!button) return;

  const active = Boolean(currentCard && currentCard.important);
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", active ? "true" : "false");
}

function updateImportantIndicator() {
  const indicator = $("importantIndicator");
  if (!indicator) return;

  const active = Boolean(currentCard && currentCard.important);
  indicator.hidden = !active;
}

function findColumn(header, names) {
  return header.findIndex(h => names.includes(h));
}

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += ch;
      }
    }
  }

  row.push(field.replace(/\r$/, ""));
  if (row.some(v => v !== "")) rows.push(row);

  return rows;
}

function getCard(key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function putCard(card) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(card);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getCardsByBook(bookKey) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const index = tx.objectStore(STORE_NAME).index("book");
    const req = index.getAll(bookKey);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function getActiveCards(bookKey) {
  const cards = await getCardsByBook(bookKey);
  return cards.filter(c => !c.deleted);
}

async function resetBook(bookKey) {
  const cards = await getCardsByBook(bookKey);

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const card of cards) store.delete(card.key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });

  await refreshHomeCounts();

  const book = BOOKS.find(b => b.key === bookKey);
  setHomeMessage(`${book.label}を初期化しました。`);
}

async function resetAll() {
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });

  await refreshHomeCounts();
  setHomeMessage("全単語帳を初期化しました。");
}

async function refreshHomeCounts() {
  if (!db) return;

  for (const book of BOOKS) {
    const cards = await getActiveCards(book.key);
    const el = $(`count-${book.key}`);
    if (el) el.textContent = `${cards.length}問`;
  }
}

function setHomeMessage(text) {
  $("homeMessage").textContent = text;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* GitHub CSVへの削除一括反映。トークンは保存せず、同期時の入力だけで使用。 */
const GH_SETTINGS_KEY = 'wordbookGithubSettings';
let githubSyncRunning = false;

function setupGithubSync() {
  const tools = document.querySelector('.home-tools');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'githubSyncButton';
  btn.className = 'secondary';
  btn.textContent = 'GitHubに削除を反映';
  tools.insertAdjacentElement('afterend', btn);
  btn.addEventListener('click', showGithubSyncDialog);
  btn.style.cssText = 'display:block;width:min(100%,420px);min-height:52px;margin:12px auto 0;';

  const dialog = document.createElement('dialog');
  dialog.id = 'githubSyncDialog';
  dialog.innerHTML = `
    <form id="githubSyncForm">
      <h2>GitHubに削除を反映</h2>
      <p id="githubPendingText">削除待ちを確認中</p>
      <label class="gh-label" for="ghOwner">GitHubユーザー名（Owner）</label>
      <input id="ghOwner" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" required>
      <label class="gh-label" for="ghRepo">リポジトリ名</label>
      <input id="ghRepo" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" required>
      <label class="gh-label" for="ghBranch">ブランチ名</label>
      <input id="ghBranch" type="text" value="main" autocapitalize="off" autocomplete="off" spellcheck="false" required>
      <label class="gh-label" for="ghFolder">CSVのフォルダ（ルートなら空欄）</label>
      <input id="ghFolder" type="text" placeholder="例: data" autocapitalize="off" autocomplete="off" spellcheck="false">
      <label class="gh-label" for="ghToken">Fine-grained personal access token</label>
      <input id="ghToken" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required>
      <p>トークンは保存しません。Contents: Read and write、対象リポジトリのみを許可してください。</p>
      <p id="ghSyncMessage" role="status" aria-live="polite"></p>
      <button id="ghSyncSubmit" type="submit">削除を一括反映</button>
      <button id="ghSyncCancel" class="secondary" type="button">閉じる</button>
    </form>`;
  document.body.appendChild(dialog);
  const saved = JSON.parse(localStorage.getItem(GH_SETTINGS_KEY) || '{}');
  $('ghOwner').value = saved.owner || '';
  $('ghRepo').value = saved.repo || '';
  $('ghBranch').value = saved.branch || 'main';
  $('ghFolder').value = saved.folder || '';
  $('ghSyncCancel').addEventListener('click', () => { if (!githubSyncRunning) dialog.close(); });
  dialog.addEventListener('close', () => { $('ghToken').value = ''; });
  $('githubSyncForm').addEventListener('submit', submitGithubSync);
}

async function pendingGithubDeletes() {
  const pending = new Map();
  for (const book of BOOKS) {
    const cards = (await getCardsByBook(book.key)).filter(c => c.deleted && c.syncedDelete !== true);
    if (cards.length) pending.set(book.key, cards);
  }
  return pending;
}

async function showGithubSyncDialog() {
  const pending = await pendingGithubDeletes();
  const total = [...pending.values()].reduce((n, cards) => n + cards.length, 0);
  $('githubPendingText').textContent = `GitHubへの削除反映待ち: ${total}件（${[...pending.entries()].map(([key, cards]) => `${BOOKS.find(b => b.key === key).label} ${cards.length}件`).join('、') || 'なし'}）`;
  $('ghSyncMessage').textContent = '';
  $('ghSyncSubmit').disabled = total === 0;
  $('githubSyncDialog').showModal();
}

function encodeGithubContent(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function decodeGithubContent(base64) {
  const binary = atob(base64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function stringifyCsv(rows) {
  return rows.map(row => row.map(cell => {
    const v = String(cell ?? '');
    return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
  }).join(',')).join('\r\n') + '\r\n';
}

async function githubRequest(url, token, method = 'GET', body) {
  const result = await fetch(url, {
    method,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store'
  });
  if (!result.ok) {
    let error = '';
    try { error = (await result.json()).message || ''; } catch (_) {}
    throw new Error(`GitHub API ${result.status}: ${error || result.statusText}`);
  }
  return result.json();
}

async function submitGithubSync(event) {
  event.preventDefault();
  if (githubSyncRunning) return;
  const owner = $('ghOwner').value.trim();
  const repo = $('ghRepo').value.trim();
  const branch = $('ghBranch').value.trim();
  const folder = $('ghFolder').value.trim().replace(/^\/+|\/+$/g, '');
  const token = $('ghToken').value.trim();
  if (!owner || !repo || !branch || !token) return;
  if (![owner, repo, branch].every(s => !/[\/?#]/.test(s)) || folder.split('/').includes('..')) {
    $('ghSyncMessage').textContent = 'ユーザー名、リポジトリ名、ブランチ名またはフォルダを確認してください。';
    return;
  }
  const pending = await pendingGithubDeletes();
  if (!pending.size) { $('ghSyncMessage').textContent = '反映待ちの問題はありません。'; return; }
  localStorage.setItem(GH_SETTINGS_KEY, JSON.stringify({owner, repo, branch, folder}));
  if (!confirm(`GitHubの${repo}（${branch}）にあるCSVから削除済み問題を反映します。続けますか？`)) return;
  githubSyncRunning = true;
  $('ghSyncSubmit').disabled = true;
  $('ghSyncCancel').disabled = true;
  let done = 0;
  let changedFiles = 0;
  try {
    for (const [bookKey, cards] of pending) {
      const book = BOOKS.find(b => b.key === bookKey);
      $('ghSyncMessage').textContent = `${book.label}を処理中...（${done}件完了）`;
      const path = [folder, book.csv].filter(Boolean).join('/');
      const pathPart = path.split('/').map(encodeURIComponent).join('/');
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${pathPart}`;
      // 毎回GitHubの最新CSVとshaを取得し、当該IDの行だけ除去する。
      const current = await githubRequest(`${url}?ref=${encodeURIComponent(branch)}`, token);
      if (current.type !== 'file' || typeof current.content !== 'string') {
        throw new Error(`${path}: ファイル内容を取得できません（1MBを超えるファイルなど）。`);
      }
      const original = decodeGithubContent(current.content);
      const rows = parseCsv(original);
      if (!rows.length || rows[0].length < 3 || rows[0][0].replace(/^\uFEFF/, '').trim() !== 'ID') {
        throw new Error(`${path}: CSVの先頭列がIDではありません。更新を中止しました。`);
      }
      const ids = new Set(cards.map(c => String(c.id).trim()));
      const remain = [rows[0], ...rows.slice(1).filter(row => !ids.has(String(row[0] ?? '').trim()))];
      const removed = rows.length - remain.length;
      if (removed) {
        const updated = stringifyCsv(remain);
        await githubRequest(url, token, 'PUT', {
          message: `wordbook: remove ${removed} deleted card(s) from ${book.csv}`,
          content: encodeGithubContent(updated),
          sha: current.sha,
          branch
        });
        changedFiles++;
      }
      // GitHub更新成功時（または既にIDが存在しない場合）のみ処理済みにする。
      for (const card of cards) {
        const latest = await getCard(card.key);
        if (latest && latest.deleted) {
          latest.syncedDelete = true;
          await putCard(latest);
        }
      }
      done += cards.length;
    }
    $('ghSyncMessage').textContent = `完了: ${done}件を確認、${changedFiles}個のCSVを更新しました。`;
    await refreshHomeCounts();
  } catch (err) {
    console.error('GitHub同期エラー:', err);
    $('ghSyncMessage').textContent = `中断: ${err.message}（完了 ${done}件）。未反映分は残っています。`;
  } finally {
    $('ghToken').value = '';
    $('ghSyncCancel').disabled = false;
    githubSyncRunning = false;
    $('ghSyncSubmit').disabled = false;
    const remaining = await pendingGithubDeletes();
    if (!remaining.size) $('ghSyncSubmit').disabled = true;
  }
}
