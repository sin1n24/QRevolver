/**
 * QRevolver ランキング保存用 GAS Webアプリ
 * Googleスプレッドシートを「月別ランキングのデータベース」として使う。
 *
 * ■セットアップ
 *  1. 新しいGoogleスプレッドシートを作成（中身は空でOK。初回書き込み時にヘッダを自動作成）。
 *  2. 拡張機能 → Apps Script を開き、このコードを貼り付け。
 *  3. スクリプトプロパティに任意の合言葉を設定（推奨）:
 *     プロジェクトの設定 → スクリプト プロパティ → SECRET = 好きな文字列
 *  4. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *       次のユーザーとして実行: 自分
 *       アクセスできるユーザー: 全員
 *     → 発行された /exec のURLを控える（NodeのGAS_URLに設定）。
 *  ※ Nodeサーバーからのみ呼ばれる（ブラウザから直接は叩かない）ので、SECRETで書き込みを保護できる。
 *
 * ■データ形式（シート列）
 *   month(YYYY-MM) | duration(秒) | name | location | timestamp
 *   月キーでフィルタするので、毎月リセット＝新しい月は自動的に空から始まる（旧月は履歴として残る）。
 */

var SHEET_NAME = 'records';
var RECORD_MAX = 10;          // 1か月あたりの上位保持数
var TZ = 'Asia/Tokyo';

function doGet(e) {
  var month = (e && e.parameter && e.parameter.month) || currentMonth_();
  return json_({ ok: true, month: month, ranking: top_(month) });
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}

  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (secret && body.secret !== secret) {
    return json_({ ok: false, error: 'unauthorized' });
  }

  var month = body.month || currentMonth_();
  var rec = {
    duration: Number(body.duration),
    name: String(body.name || '名無し').slice(0, 16),
    location: String(body.location || '').slice(0, 16),
    timestamp: String(body.timestamp || nowStamp_())
  };
  if (!isFinite(rec.duration)) return json_({ ok: false, error: 'bad duration' });

  appendRow_(month, rec);
  return json_({ ok: true, month: month, ranking: top_(month) });
}

/* ---- helpers ---- */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(['month', 'duration', 'name', 'location', 'timestamp']);
  }
  return sh;
}

function appendRow_(month, rec) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    getSheet_().appendRow([month, rec.duration, rec.name, rec.location, rec.timestamp]);
  } finally {
    lock.releaseLock();
  }
}

function top_(month) {
  var sh = getSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, 5).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) !== String(month)) continue;
    out.push({
      duration: Number(rows[i][1]),
      name: String(rows[i][2]),
      location: String(rows[i][3]),
      timestamp: String(rows[i][4])
    });
  }
  out.sort(function (a, b) { return a.duration - b.duration; });
  return out.slice(0, RECORD_MAX);
}

function currentMonth_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
}
function nowStamp_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm');
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
