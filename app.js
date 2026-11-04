/*
  iPhone用単語帳

  GitHubに置くCSV:
  english.csv
  infotech.csv
  other.csv

  各CSVの1行目:
  問題,答え,出題回数,正解回数,重要フラグ
*/

const BOOKS = [
  { key: "english", label: "英語", csv: "english.csv" },
  { key: "infotech", label: "情報", csv: "infotech.csv" },
  { key: "guide", label: "その他", csv: "other.csv" }
];

const DB_NAME = "WordbookDB";
const DB_VERSION = 1;
const STORE_NAME = "cards";
const RATE_STORAGE_KEY = "wordbookQuestionRate";
const DEFAULT_QUESTION_RATE = 5;
const FONT_SIZE_STORAGE_KEY = "wordbookFontSize";

let db;
let currentBook = null;
let currentCard = null;
let showingAnswer = false;
let fontSize = 34;
let touchStartX = null;
let touchStartY = null;
let touchStartTime = 0;
let ignoreNextCardClick = false;
let questionRate = DEFAULT_QUESTION_RATE;

const $ = (id) => document.getElementById(id);

async function initializeApp() {
  loadFontSize();
  db = await openDB();
  loadQuestionRate();
  buildHomeButtons();
  buildDialogButtons();
  bindEvents();
  setupCsvExport();
  await refreshHomeCounts();
}

// JavaScriptを動的にロードしても必ず初期化する。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp, { once: true });
} else {
  initializeApp();
}

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

  for (const book of BOOKS) {
    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.textContent = `${book.label}を取り込む`;
    importBtn.addEventListener("click", async () => {
      $("importDialog").close();
      await importCsv(book.key);
    });
    $("importChoices").appendChild(importBtn);


  }
}

function bindEvents() {
  $("importButton").addEventListener("click", () => $("importDialog").showModal());
  $("refreshButton").addEventListener("click", refreshAppFromServer);

  $("questionRateSelect").addEventListener("change", (e) => {
    questionRate = Math.max(1, Math.min(10, Number(e.target.value) || DEFAULT_QUESTION_RATE));
    localStorage.setItem(RATE_STORAGE_KEY, String(questionRate));
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
    await putCard(currentCard);
    await nextCard();
  });

  $("fontUpButton").addEventListener("click", () => changeFont(2));
  $("fontDownButton").addEventListener("click", () => changeFont(-2));

  // 短いタップは裏返す。長押しは標準の文字選択／コピーに渡す。
  // iPhoneで選択メニューを出すため、長押し時のpreventDefaultは禁止。
  const card = $("card");
  card.addEventListener("click", () => {
    if (ignoreNextCardClick) {
      ignoreNextCardClick = false;
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().length > 0) return;
    if (touchStartTime && Date.now() - touchStartTime >= 450) return;
    toggleSide();
  });

  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleSide();
    }
  });

  card.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchStartTime = Date.now();
    ignoreNextCardClick = false;
  }, { passive: true });

  card.addEventListener("touchend", (event) => {
    if (touchStartX === null || !event.changedTouches.length) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    const duration = Date.now() - touchStartTime;
    const selection = window.getSelection();
    const isSelecting = Boolean(selection && !selection.isCollapsed && selection.toString());

    if (duration >= 450 || isSelecting) {
      // 長押しはコピー操作。タップ扱いで答えが切り替わらないようにする。
      ignoreNextCardClick = true;
    } else if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      // すばやい横スワイプは従来どおり問題・答えを切り替える。
      ignoreNextCardClick = true;
      event.preventDefault();
      toggleSide();
    }
    touchStartX = null;
    touchStartY = null;
  }, { passive: false });

  card.addEventListener("touchcancel", () => {
    touchStartX = null;
    touchStartY = null;
    ignoreNextCardClick = true;
  }, { passive: true });

}


// GitHub PagesからHTMLを再取得し、古いService Worker/CacheStorageを整理する。
// IndexedDBとlocalStorage（単語・学習履歴・設定）は一切消さない。
async function refreshAppFromServer() {
  const button = $("refreshButton");
  button.disabled = true;
  setHomeMessage("最新の画面を確認しています…");
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("refresh", String(Date.now()));
    // ネット未接続や404のまま画面を更新してしまわないよう先に確認。
    const response = await fetch(url.toString(), { cache: "no-store" });
    if (!response.ok) throw new Error(`画面取得失敗（HTTP ${response.status}）`);
    const html = await response.text();
    if (!html.includes('id="homeScreen"') || !html.includes('app.js')) {
      throw new Error('取得したページが単語帳ではありません');
    }

    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        // この単語帳のディレクトリが管理対象の登録のみ解除する。
        if (new URL(registration.scope).pathname === new URL('./', location.href).pathname) {
          await registration.unregister();
        }
      }
    }
    if ("caches" in window) {
      const names = await caches.keys();
      // 他のWebアプリのキャッシュには触れない。
      for (const name of names) {
        if (/wordbook|tango/i.test(name)) await caches.delete(name);
      }
    }
    setHomeMessage("最新版を読み込みます…");
    window.location.replace(url.toString());
  } catch (error) {
    console.error(error);
    setHomeMessage(`更新できませんでした: ${error.message}。通信状態を確認してください。`);
    button.disabled = false;
  }
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

/* 出題回数による最低優先枠は設けず、正解率と重要フラグで重み付けする。 */
function chooseCard(cards) {
  // 出題率Nとは、正解率0%の問題を正解率100%の問題のN倍出しやすくする設定。
  // 重要問題だけ正解率0%相当の重みとする。
  const weights = cards.map(c => {
    let effectiveAccuracy = c.shownCount > 0 ? c.correctCount / c.shownCount : 0;

    if (c.important) {
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
    `出題 ${currentCard.shownCount}回　正解率 ${accuracy}%　全${total}問`;

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
    setHomeMessage(`${book.label}のCSVを読み込んでいます…`);
    let response = await fetch(`${book.csv}?v=${Date.now()}`, { cache: "no-store" });
    // 従来のguide.csvだけが存在する場合は互換性のため読み込めるようにする。
    if (!response.ok && book.key === "guide") {
      response = await fetch(`guide.csv?v=${Date.now()}`, { cache: "no-store" });
    }
    if (!response.ok) throw new Error(`CSV取得失敗: ${response.status}（${book.csv}を確認してください）`);
    const rows = parseCsv(await response.text());
    // 不正なCSVで既存データを失わないよう、読み込み・検証を全て終えてから一括更新する。
    if (!rows.length || rows[0].map(s => s.trim().replace(/^\uFEFF/, '')).slice(0, 5).join(',') !== '問題,答え,出題回数,正解回数,重要フラグ') {
      throw new Error('CSVの見出しは「問題,答え,出題回数,正解回数,重要フラグ」の5列にしてください。旧3列CSVは取り込めません。');
    }
    const cards = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.every(v => !String(v).trim())) continue;
      if (row.length !== 5) throw new Error(`${i + 1}行目の列数が5ではありません。`);
      const [question, answer, shown, correct, important] = row.map(s => String(s).trim());
      if (!question && !answer) throw new Error(`${i + 1}行目の問題と答えが空欄です。`);
      if (!/^(0|[1-9]\d*)$/.test(shown) || !/^(0|[1-9]\d*)$/.test(correct) || !['0','1'].includes(important)) {
        throw new Error(`${i + 1}行目の学習履歴が不正です。回数は0以上の整数、重要は0か1です。`);
      }
      const shownCount = Number(shown), correctCount = Number(correct);
      if (!Number.isSafeInteger(shownCount) || !Number.isSafeInteger(correctCount) || correctCount > shownCount) {
        throw new Error(`${i + 1}行目の正解回数が出題回数を超えているか、数値が大きすぎます。`);
      }
      // 内部の管理キーは取込ごとに自動生成。CSVにIDは不要。
      const internalId = String(cards.length + 1);
      cards.push({ key: makeKey(bookKey, internalId), book: bookKey, id: internalId,
        question, answer, shownCount, correctCount, important: important === '1', deleted: false });
    }
    if (!cards.length) throw new Error('問題がありません。既存の単語帳は変更しませんでした。');
    const oldCards = await getCardsByBook(bookKey);
    if (!confirm(`${book.label}の既存データ（削除済みを含む${oldCards.length}件）を消し、CSVの${cards.length}件に入れ替えます。\nCSVに含まれない最新の学習履歴は失われます。続行しますか？`)) {
      setHomeMessage(`${book.label}の取込を取り消しました。`); return;
    }
    // 同じIndexedDBトランザクション内で旧データ削除→新データ登録。
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const c of oldCards) store.delete(c.key);
      for (const c of cards) store.put(c);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('取込中に中断されました'));
    });
    await refreshHomeCounts();
    setHomeMessage(`${book.label}: ${cards.length}問を学習履歴付きで入れ替えました。`);
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


/* CSV書出し: この端末に登録済みのカードのうち、削除フラグのないものだけを出力 */
function setupCsvExport() {
  const tools = document.querySelector('.home-tools');
  const button = document.createElement('button');
  button.id = 'csvExportButton';
  button.type = 'button';
  button.className = 'secondary';
  button.textContent = 'CSVダウンロード';
  tools.insertAdjacentElement('afterend', button);
  button.addEventListener('click', () => $('csvExportDialog').showModal());
  const choices = $('csvExportChoices');
  for (const book of BOOKS) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.textContent = `${book.label}（${book.csv}）`; 
    choice.addEventListener('click', () => exportCsv(book.key));
    choices.appendChild(choice);
  }
}

function csvCell(value) {
  // 改行・カンマ・引用符を含む問題や答えもExcelで正しく開く
  const s = String(value == null ? '' : value);
  return '"' + s.replaceAll('"', '""') + '"';
}

async function exportCsv(bookKey) {
  const book = BOOKS.find(b => b.key === bookKey);
  if (!book) return;
  const status = $('csvExportMessage');
  status.textContent = 'CSVを作成しています…';
  try {
    const all = await getCardsByBook(bookKey);
    if (!all.length) throw new Error('この端末にはデータがありません。先にデータ取込をしてください。');
    const active = all.filter(card => !card.deleted);
    const deleted = all.length - active.length;
    const lines = ['問題,答え,出題回数,正解回数,重要フラグ', ...active.map(card => [card.question,card.answer,card.shownCount || 0,card.correctCount || 0,card.important ? 1 : 0].map(csvCell).join(','))];
    // BOM付きUTF-8で、日本語や複数行の答えをExcelに読み込みやすくする
    const blob = new Blob(['\uFEFF', lines.join('\r\n') + '\r\n'], { type:'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = book.csv;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = `${book.label}: ${active.length}件を書き出しました（削除済み${deleted}件を除外）。`;
  } catch (error) {
    console.error(error);
    status.textContent = `書出しエラー: ${error.message}`;
  }
}
