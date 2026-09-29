/**
 * SUUMO 反響(JDS)／内見(見学)予約メール → Slack「#2-ヒアリング予約通知__今は売買のみ」通知
 *
 * info@naikenboys.co.jp に届く以下のメールを5分おきに拾い、Slack に投稿する。
 *   - system@jds.suumo.jp              : [リクルートＪＤＳ]反響お知らせメール
 *   - reserve-info@kr-hometour.suumo.jp : 見学予約／仮予約／案内日時の変更／キャンセル など
 *
 * 設定: 下の SLACK_WEBHOOK_URL の '' の間に Slack の Webhook URL を貼る。
 * 初回: setup() を1回だけ手動実行する(既存メールを通知済みにして、5分おきのトリガーを作る)。
 */

// ↓↓↓ ここの '' の間に、Slack で作った https://hooks.slack.com/services/... のURLを貼る ↓↓↓
var SLACK_WEBHOOK_URL = '';

var JDS_SENDER = 'system@jds.suumo.jp';
var RESERVE_SENDER = 'reserve-info@kr-hometour.suumo.jp';
var SEARCH_QUERY = '(from:' + JDS_SENDER + ' OR from:' + RESERVE_SENDER + ') newer_than:2d';
var MENTION = '<!subteam^S08EM4Q17HS>'; // これまでのJDS反響通知と同じメンション先
var PROCESSED_KEY = 'PROCESSED_MESSAGE_IDS';
var MAX_PROCESSED = 500;

function setup() {
  // 過去メールを一気に流さないよう、今あるものは通知済み扱いにする
  var ids = [];
  GmailApp.search(SEARCH_QUERY).forEach(function (thread) {
    thread.getMessages().forEach(function (m) { ids.push(m.getId()); });
  });
  saveProcessed_(ids);

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkSuumoReservations') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkSuumoReservations').timeBased().everyMinutes(5).create();
}

function checkSuumoReservations() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return;
  try {
    var processed = loadProcessed_();
    var seen = {};
    processed.forEach(function (id) { seen[id] = true; });

    var messages = [];
    GmailApp.search(SEARCH_QUERY).forEach(function (thread) {
      thread.getMessages().forEach(function (m) {
        if (!seen[m.getId()]) messages.push(m);
      });
    });
    messages.sort(function (a, b) { return a.getDate() - b.getDate(); });

    messages.forEach(function (m) {
      postToSlack_(buildText_(m));
      processed.push(m.getId());
      saveProcessed_(processed); // 途中で失敗しても二重投稿しないよう1件ごとに保存
    });
  } finally {
    lock.releaseLock();
  }
}

function buildText_(m) {
  return m.getFrom().indexOf(JDS_SENDER) !== -1
    ? buildJdsText_(m.getPlainBody())
    : buildReserveText_(m.getSubject(), m.getPlainBody());
}

function pick_(body, label) {
  var m = body.match(new RegExp('^\\s*' + label + '：\\s*(.*)$', 'm'));
  return m && m[1].trim() && m[1].trim() !== '-' ? m[1].trim() : '';
}

// これまでSlackに流れていたJDS反響通知と同じ体裁
function buildJdsText_(body) {
  var lines = [MENTION + ' :envelope_with_arrow: *JDS反響通知が届きました*'];
  lines.push('*日時：* ' + pick_(body, '日時'));
  lines.push('*企画：* ' + pick_(body, '企画'));
  lines.push('*ID：* ' + (pick_(body, 'ＩＤ') || pick_(body, 'ID')));
  lines.push('*URL：* <https://jds.suumo.jp/>');
  return lines.join('\n');
}

function buildReserveText_(subject, body) {
  var f = function (label) { return pick_(body, label); };
  var url = (body.match(/https:\/\/kr-hometour\.suumo\.jp\/reservations\/\S+/) || [''])[0];

  var lines = [MENTION + ' :house: *SUUMO内見予約通知が届きました*'];
  lines.push('*件名：* ' + subject.replace(/^【SUUMO】/, ''));
  if (f('受付日時')) lines.push('*受付日時：* ' + f('受付日時'));
  if (f('予約状況')) lines.push('*予約状況：* ' + f('予約状況'));

  if (f('変更前')) {
    lines.push('*変更前：* ' + f('変更前'));
    lines.push('*新しい案内日時：* ' + (f('新規の案内日時') || f('案内日時')));
  } else if (f('案内日時')) {
    lines.push('*案内日時：* ' + f('案内日時'));
  }
  if (f('集合場所')) lines.push('*集合場所：* ' + f('集合場所'));

  var bukken = f('物件名');
  if (bukken) lines.push('*物件：* ' + bukken + (f('価格') ? '(' + f('価格') + ')' : ''));

  var name = f('氏名（漢字）');
  if (name) lines.push('*お客様：* ' + name + (f('氏名（カナ）') ? '(' + f('氏名（カナ）') + ')' : '') + ' 様');
  if (f('連絡事項')) lines.push('*連絡事項：* ' + f('連絡事項'));

  lines.push('*予約詳細：* ' + (url ? '<' + url + '>' : '<https://kr-hometour.suumo.jp/>'));
  return lines.join('\n');
}

function postToSlack_(text) {
  var webhook = SLACK_WEBHOOK_URL ||
    PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!webhook) throw new Error('コードの一番上の SLACK_WEBHOOK_URL にSlackのURLを貼ってください');
  var res = UrlFetchApp.fetch(webhook, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Slack投稿失敗: ' + res.getResponseCode() + ' ' + res.getContentText());
  }
}

function loadProcessed_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROCESSED_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveProcessed_(ids) {
  PropertiesService.getScriptProperties()
    .setProperty(PROCESSED_KEY, JSON.stringify(ids.slice(-MAX_PROCESSED)));
}

/** 動作確認用: 直近の反響メール・予約メールを1件ずつ、Slack に送らずログに出す */
function previewLatest() {
  [JDS_SENDER, RESERVE_SENDER].forEach(function (sender) {
    var thread = GmailApp.search('from:' + sender + ' newer_than:60d', 0, 1)[0];
    if (!thread) { Logger.log(sender + ': 対象メールなし'); return; }
    Logger.log(buildText_(thread.getMessages().pop()));
  });
}
