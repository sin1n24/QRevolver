// QRevolver - The Quick-Scan Showdown, Reloaded
// QRGunman(M5Stack版) のWeb移植・改良版。クラウド公開対応・月別ランキング付き。
//
// ■計測の肝（元のM5Stackと同じ思想）
//   元のM5Stackは「自分自身がWebサーバー」だったため、
//   fire(QR表示)時刻 と phoneがGETで到達した時刻 を “同じ時計” で測れた。
//   このNodeサーバーも同じ役割を担い、fireTime と scan到達時刻 を
//   すべてサーバー時計(Date.now)で測ることで、端末間の時計ズレに影響されない
//   正確な早撃ちタイムを実現する。
//
// ■クラウド公開とランキング永続化
//   - QRに埋め込む公開URLはリクエストのホストから自動導出（Render等のドメインを自動採用）。
//   - ランキングは「月キー(YYYY-MM, JST)」でバケット化し、毎月自動リセット（旧月は履歴として残る）。
//   - 永続化先は GAS Webアプリ＋スプレッドシート（GAS_URL設定時）。未設定ならローカルrecords.jsonに保存。

import express from "express";
import qrcode from "qrcode";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const RECORDS_FILE = path.join(__dirname, "records.json");
const RECORD_MAX = 10;                       // 1か月あたりのランキング保持数
const TZ = process.env.TZ_DISPLAY || "Asia/Tokyo";
const GAS_URL = process.env.GAS_URL || "";   // GAS Webアプリ /exec のURL（未設定ならローカル保存）
const GAS_SECRET = process.env.GAS_SECRET || "";

// ---- 公開URL（QRに埋め込むベースURL）----------------------------------------
// 優先順位: PUBLIC_URL > RENDER_EXTERNAL_URL > リクエストから自動導出
function baseUrlFrom(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`; // trust proxy 有効なので https / 正しいhostを拾う
}
let publicBase = ""; // /start 時のリクエストから確定し、fire()で使う

// ---- 日付ヘルパ（JST基準）---------------------------------------------------
function monthKey(d = new Date()) {
  // "2026-06" のような月キー
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(d);
}
function monthLabelJP(key = monthKey()) {
  const m = parseInt(key.slice(5, 7), 10);
  return `${m}月`;
}
function nowStamp() {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${g("year")}/${g("month")}/${g("day")} ${g("hour")}:${g("minute")}`;
}

// ---- ストレージ（GAS or ローカルJSON）--------------------------------------
// storageList(month): その月の上位記録（昇順, 最大RECORD_MAX）を返す
// storageAdd(month, rec): 追記して、その月の最新上位記録を返す
async function storageList(month) {
  if (GAS_URL) {
    try {
      const res = await fetch(`${GAS_URL}?month=${encodeURIComponent(month)}`, { redirect: "follow" });
      const data = await res.json();
      return Array.isArray(data.ranking) ? data.ranking : [];
    } catch (e) {
      console.error("GAS list failed:", e.message);
      return [];
    }
  }
  return localTop(month);
}
async function storageAdd(month, rec) {
  if (GAS_URL) {
    try {
      const res = await fetch(GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...rec, month, secret: GAS_SECRET }),
        redirect: "follow",
      });
      const data = await res.json();
      if (data && Array.isArray(data.ranking)) return data.ranking;
    } catch (e) {
      console.error("GAS add failed:", e.message);
    }
    return null;
  }
  localAppend(month, rec);
  return localTop(month);
}

// ローカルフォールバック（records.json は全月のレコードを月キー付きで保持）
function localAll() {
  try {
    const data = JSON.parse(fs.readFileSync(RECORDS_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function localTop(month) {
  return localAll()
    .filter((r) => r.month === month)
    .sort((a, b) => a.duration - b.duration)
    .slice(0, RECORD_MAX);
}
function localAppend(month, rec) {
  const all = localAll();
  all.push({ month, ...rec });
  try { fs.writeFileSync(RECORDS_FILE, JSON.stringify(all, null, 2)); }
  catch (e) { console.error("records save failed:", e.message); }
}

// ---- ランキングのメモリキャッシュ（高速な /result と当落判定に使用）---------
let records = [];                 // 現在月の上位記録（昇順）
let recordsMonth = null;          // キャッシュ中の月キー
async function ensureMonth() {
  const cur = monthKey();
  if (recordsMonth !== cur) {     // 月が変わったら（＝自動リセット）読み直し
    recordsMonth = cur;
    records = await storageList(cur);
  }
  return cur;
}
function isRankIn(duration) {
  if (records.length < RECORD_MAX) return true;
  return duration < records[records.length - 1].duration;
}
function applyToCache(rec) {
  records.push(rec);
  records.sort((a, b) => a.duration - b.duration);
  if (records.length > RECORD_MAX) records.length = RECORD_MAX;
}

// ---- ゲーム状態（元の state_t 相当）-----------------------------------------
const STATE = { TITLE: "TITLE", WAIT: "WAIT", MEASURE: "MEASURE", RESULT: "RESULT" };
let state = STATE.TITLE;
let fireTime = 0;          // QR表示(=抜き)の瞬間。サーバー時計。
let currentRound = null;   // 現在ラウンドの使い捨てID（先読み防止）
let fireTimer = null;      // WAIT→MEASURE の予約タイマー
const roundResults = new Map(); // roundId -> { duration, falseStart, timestamp, ranked, registered }

// ---- 西部劇テイストのAIコメント（原作 aicomment / thankscomment 移植）-------
const aicomment = [
  "まだ旅は終わっちゃいないぜ。",
  "次のチャンスは、もうコルトに装填済みだ。",
  "風向きが変わるのを、俺は知ってる。",
  "ランキングにゃ載らなくても、伝説は始まってるぜ。",
  "今日撃ち損じても、明日には名を刻めるさ。",
];
const thankscomment = [
  "ご参加ありがとうございました。",
  "またの挑戦をお待ちしています。",
  "次回もよろしくお願いします。",
  "あなたの挑戦をお待ちしています。",
  "参加ありがとう！また会いましょう。",
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---- SSE（サーバー→ディスプレイへの一方向プッシュ）--------------------------
const clients = new Set();
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
}

// ---- ラウンド進行 ------------------------------------------------------------
function startRound() {
  if (fireTimer) clearTimeout(fireTimer);
  state = STATE.WAIT;
  currentRound = null;
  broadcast({ type: "waiting" });
  // 元: timer = random(300,500) * 10ms = 3.0〜5.0秒
  scheduleFire(3000 + Math.floor(Math.random() * 2000));
}
function scheduleFire(ms) {
  if (fireTimer) clearTimeout(fireTimer);
  fireTimer = setTimeout(fire, ms);
}
async function fire() {
  state = STATE.MEASURE;
  fireTime = Date.now();
  currentRound = Math.random().toString(36).slice(2, 10);
  // QRはラウンド毎に変わる使い捨てURL → 事前スキャン・先読みチートを防止
  const hitUrl = `${publicBase}/hit?r=${currentRound}`;
  const qrDataUrl = await qrcode.toDataURL(hitUrl, {
    margin: 1, width: 600, color: { dark: "#3b2412", light: "#ffffff" },
  });
  broadcast({ type: "fire", qr: qrDataUrl, url: hitUrl });
}

// ---- Express -----------------------------------------------------------------
const app = express();
app.set("trust proxy", true); // Render等のプロキシ越しで https / 正しいhostを拾う
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/assets", express.static(path.join(__dirname, "public/assets")));

// ディスプレイ（M5Stackの置き換え。PC/スマホで開く早撃ち台）
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public/display.html")));
app.get("/play", (_req, res) => res.sendFile(path.join(__dirname, "public/play.html")));

// SSEストリーム
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // プロキシのバッファリング無効化
  });
  res.flushHeaders?.();
  res.write("retry: 2000\n\n");
  clients.add(res);
  res.write(`data: ${JSON.stringify({ type: "hello", state })}\n\n`);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25_000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});

// ディスプレイから「抜き始め」（元のボタン押下に相当）
app.post("/start", async (req, res) => {
  publicBase = baseUrlFrom(req); // QRに使う公開URLをこのリクエストから確定
  await ensureMonth();           // 月が変わっていればランキングを読み直す
  startRound();
  res.json({ ok: true });
});

// スマホがQRをスキャン→ブラウザが開く到達点。ここで早撃ちタイムを確定。
app.get("/hit", async (req, res) => {
  const r = String(req.query.r || "");
  await ensureMonth();
  if (state === STATE.MEASURE && r && r === currentRound) {
    const duration = (Date.now() - fireTime) / 1000; // ★同一時計で計測
    state = STATE.RESULT;
    if (fireTimer) clearTimeout(fireTimer);
    const ranked = isRankIn(duration);
    roundResults.set(r, { duration, falseStart: false, timestamp: nowStamp(), ranked, registered: false });
    broadcast({ type: "bang", duration });
  } else if (state === STATE.WAIT) {
    if (r) roundResults.set(r, { falseStart: true }); // QRが出る前にスキャン＝フライング
    broadcast({ type: "falsestart" });
  } else if (r && !roundResults.has(r)) {
    roundResults.set(r, { stale: true });
  }
  res.sendFile(path.join(__dirname, "public/play.html"));
});

// 結果ページ用データ
app.get("/result", async (req, res) => {
  const r = String(req.query.r || "");
  await ensureMonth();
  const result = roundResults.get(r) || { stale: true };
  res.json({
    ...result,
    canRegister: !!result.ranked && !result.registered,
    ranking: records,
    recordMax: RECORD_MAX,
    month: recordsMonth,
    monthLabel: monthLabelJP(recordsMonth),
    aicomment: pick(aicomment),
    thankscomment: pick(thankscomment),
  });
});

// 名前登録（元の POST / 相当）
app.post("/register", async (req, res) => {
  const r = String(req.body.r || "");
  const result = roundResults.get(r);
  if (!result || result.falseStart || result.stale || result.registered) {
    return res.json({ ok: false, message: "登録できる結果がありません。" });
  }
  await ensureMonth();
  const rec = {
    duration: result.duration,
    name: String(req.body.name || "名無し").slice(0, 16) || "名無し",
    location: String(req.body.location || "").slice(0, 16),
    timestamp: result.timestamp,
  };
  result.registered = true;
  applyToCache(rec);                 // メモリを即更新（画面反映を速く）
  broadcast({ type: "ranking", duration: rec.duration, name: rec.name });
  res.json({ ok: true, ranking: records, monthLabel: monthLabelJP(recordsMonth) });

  // 永続化（GAS or ローカル）。権威ある結果が返ればキャッシュを同期。
  const persisted = await storageAdd(recordsMonth, rec);
  if (persisted) records = persisted;
});

// 妨害（元の /freeze 移植）：相手が待機中なら抜きを遅らせる
app.get("/freeze", (_req, res) => {
  if (state === STATE.WAIT) {
    scheduleFire(5000 + Math.floor(Math.random() * 3000)); // 5〜8秒に延長
    broadcast({ type: "freeze" });
  }
  res.json({ ok: true });
});

// ランキング単体取得
app.get("/ranking", async (_req, res) => {
  await ensureMonth();
  res.json({ ranking: records, recordMax: RECORD_MAX, month: recordsMonth, monthLabel: monthLabelJP(recordsMonth) });
});

app.listen(PORT, async () => {
  await ensureMonth();
  console.log("┌──────────────────────────────────────────────");
  console.log("│  QRevolver — The Quick-Scan Showdown, Reloaded");
  console.log("├──────────────────────────────────────────────");
  console.log(`│  ローカル: http://localhost:${PORT}/`);
  console.log(`│  今月のランキング: ${recordsMonth}（${monthLabelJP()}）`);
  console.log(`│  ランキング保存先: ${GAS_URL ? "GAS(スプレッドシート)" : "ローカル records.json"}`);
  if (process.env.PUBLIC_URL) console.log(`│  公開URL(PUBLIC_URL): ${process.env.PUBLIC_URL}`);
  else if (process.env.RENDER_EXTERNAL_URL) console.log(`│  公開URL(Render): ${process.env.RENDER_EXTERNAL_URL}`);
  else console.log("│  公開URLはアクセス元ホストから自動導出（LAN/クラウド両対応）");
  console.log("└──────────────────────────────────────────────");
});
