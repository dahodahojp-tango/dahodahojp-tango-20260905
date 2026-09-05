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

let db;
let currentBook = null;
let currentCard = null;
let showingAnswer = false;
let fontSize = 34;
let touchStartX = null;
let touchStartY = null;

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  db = await openDB();
  buildHomeButtons();
  buildDialogButtons();
  bindEvents();
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

  $("resetAllButton").addEventListener("click", async (e) => {
    e.preventDefault();
    $("resetDialog").close();
    if (confirm("全単語帳を完全に初期化しますか？\n学習履歴と削除済み記録もすべて消えます。")) {
      await resetAll();
    }
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
  $("bookTitle").textContent = currentBook.label;
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
    $("sideLabel").textContent = "";
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
  const never = cards.filter(c => c.shownCount === 0);
  if (never.length) return randomOne(never);

  const early = cards.filter(c => c.shownCount >= 1 && c.shownCount <= 3);
  if (early.length) return randomOne(early);

  const weights = cards.map(c => {
    const accuracy = c.shownCount > 0 ? c.correctCount / c.shownCount : 0;
    return Math.max(0.05, 1.05 - accuracy);
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

  $("sideLabel").textContent = showingAnswer ? "答え" : "問題";
  $("cardText").textContent = showingAnswer ? currentCard.answer : currentCard.question;

  const accuracy = currentCard.shownCount
    ? Math.round((currentCard.correctCount / currentCard.shownCount) * 100)
    : 0;

  $("progressText").textContent =
    `ID ${currentCard.id}　出題 ${currentCard.shownCount}回　正解率 ${accuracy}%　全${total}問`;
}

function toggleSide() {
  if (!currentCard) return;
  showingAnswer = !showingAnswer;
  getActiveCards(currentBook.key).then(cards => renderCard(cards.length));
}

function changeFont(delta) {
  fontSize = Math.max(20, Math.min(60, fontSize + delta));
  document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
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
        deleted: false
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
