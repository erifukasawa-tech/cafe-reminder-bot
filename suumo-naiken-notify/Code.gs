/**
 * SUUMO 反響(JDS)／内見(見学)予約メール → Slack「#2-ヒアリング予約通知__今は売買のみ」通知
 *
 * info@naikenboys.co.jp に届く以下のメールを5分おきに拾い、Slack に投稿する。
 *   - system@jds.suumo.jp              : [リクルートＪＤＳ]反響お知らせメール
 *   - reserve-info@kr-hometour.suumo.jp : 見学予約／仮予約／案内日時の変更／キャンセル など
 *
 * JDS反響は、設定確認などのメール(件名に「確認」「設定」等を含むもの)は通知しない。
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
      if (m.getFrom().indexOf(JDS_SENDER) === -1 || isJdsInquiry_(m.getSubject())) {
        postToSlack_(buildText_(m));
      }
      processed.push(m.getId());
      saveProcessed_(processed); // 途中で失敗しても二重投稿しないよう1件ごとに保存
    });
  } finally {
    lock.releaseLock();
  }
}

function buildText_(m) {
  return m.getFrom().indexOf(JDS_SENDER) !== -1
    ? buildJdsText_(m.getSubject(), m.getPlainBody())
    : buildReserveText_(m.getSubject(), m.getPlainBody());
}

function escapeRe_(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 「ラベル：値」「【ラベル】値」「■ラベル　値」のほか、ラベルだけの行の次の行に値がある形も拾う。
// label は配列で別名を渡せる(最初に見つかったものを使う)。
function pick_(body, label) {
  var labels = [].concat(label);
  var lines = body.split(/\r?\n/);
  for (var k = 0; k < labels.length; k++) {
    var re = new RegExp('^[\\s　■□◆◇●○・＊*]*[【\\[［]?' + escapeRe_(labels[k]) +
      '[】\\]］]?[\\s　]*(?:[：:][\\s　]*|(?=[\\s　]))(.*)$');
    var bare = new RegExp('^[\\s　■□◆◇●○・＊*]*[【\\[［]?' + escapeRe_(labels[k]) + '[】\\]］]?[\\s　]*[：:]?[\\s　]*$');
    for (var i = 0; i < lines.length; i++) {
      var v = '';
      var m = lines[i].match(re);
      if (m && m[1].trim()) {
        v = m[1].trim();
      } else if (bare.test(lines[i]) && lines[i + 1] && !/^[\s　]*[【■□◆◇●○]/.test(lines[i + 1])) {
        v = lines[i + 1].trim();
      }
      if (v && v !== '-' && v !== '－' && v !== 'なし') return v;
    }
  }
  return '';
}

// 「お問い合わせ内容」のように複数行になる項目を、次の見出し・ラベル行の手前まで拾う
function pickBlock_(body, labels) {
  var lines = body.split(/\r?\n/);
  for (var k = 0; k < labels.length; k++) {
    var re = new RegExp('^[\\s　■□◆◇●○・＊*]*[【\\[［]?' + escapeRe_(labels[k]) + '[】\\]］]?[\\s　]*[：:]?[\\s　]*(.*)$');
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(re);
      if (!m) continue;
      var out = m[1].trim() ? [m[1].trim()] : [];
      for (var j = i + 1; j < lines.length; j++) {
        var l = lines[j];
        if (/^[\s　]*([【■□◆◇●○━─＝=]|[^\s：:]{1,15}[：:])/.test(l)) break;
        if (!l.trim() && out.length && !(lines[j + 1] || '').trim()) break;
        if (l.trim()) out.push(l.trim());
      }
      var text = out.join('\n').trim();
      if (text && text !== '-' && text !== 'なし') return text;
    }
  }
  return '';
}

function isJdsInquiry_(subject) {
  // 「反響詳細情報送信先メールアドレスの確認」など設定まわりのメールは反響ではないので通知しない
  return /反響/.test(subject) && !/確認|設定|登録|変更/.test(subject);
}

// JDS反響メール。「反響情報あり」の詳細メールならお客様・物件・問い合わせ内容も載せる。
// 項目名は届いたメールに合わせて別名を足していく。見つからない項目は「不明」と出す。
function buildJdsText_(subject, body) {
  var f = function (labels) { return pick_(body, labels) || '不明'; };
  var lines = [MENTION + ' :envelope_with_arrow: *JDS反響通知が届きました*'];
  lines.push('*日時：* ' + f(['日時', '反響日時', '問合せ日時', '問い合わせ日時', '反響到着日時']));
  lines.push('*企画：* ' + f(['企画', '企画名', '媒体']));
  lines.push('*ID：* ' + f(['ＩＤ', 'ID', '反響ID', '反響ＩＤ', '問合せID', '問合せＩＤ']));

  var name = pick_(body, ['氏名（カナ）', '氏名(カナ)', 'お名前（カナ）', 'お名前(カナ)', 'フリガナ', 'ふりがな', 'カナ氏名', '氏名カナ']);
  var kanji = pick_(body, ['氏名（漢字）', '氏名(漢字)', 'お名前', '氏名']);
  var detailed = !!(name || kanji || pick_(body, ['電話番号', 'TEL', 'ＴＥＬ', 'メールアドレス', 'Eメール']));

  if (detailed) {
    lines.push('');
    lines.push(':bust_in_silhouette: *お客様*');
    lines.push('*氏名（カナ）：* ' + (name || (kanji ? kanji : '不明')));
    lines.push('*電話番号：* ' + f(['電話番号', '電話', 'TEL', 'ＴＥＬ', '連絡先電話番号', '携帯電話番号']));
    lines.push('*メールアドレス：* ' + f(['メールアドレス', 'Eメール', 'Ｅメール', 'E-mail', 'Ｅ－ｍａｉｌ', 'mail']));
    var zip = pick_(body, ['郵便番号', '〒']);
    var addr = pick_(body, ['住所', 'ご住所', 'お客様住所', '現住所']);
    lines.push('*住所：* ' + (addr ? (zip ? '〒' + zip.replace(/^〒/, '') + ' ' : '') + addr : '不明'));
    lines.push('*希望連絡方法：* ' + f(['希望連絡方法', '連絡方法', 'ご希望の連絡方法', '希望連絡手段', '連絡手段', '連絡希望方法']));

    lines.push('');
    lines.push(':house_with_garden: *物件*');
    lines.push('*物件名：* ' + f(['物件名', '物件名称', 'マンション名', '建物名']));
    lines.push('*価格：* ' + f(['価格', '販売価格', '物件価格']));
    var madori = pick_(body, ['間取り', '間取']);
    var menseki = pick_(body, ['専有面積', '面積', '建物面積', '土地面積']);
    lines.push('*間取り・面積：* ' + ([madori, menseki].filter(String).join(' / ') || '不明'));
    lines.push('*所在地：* ' + f(['所在地', '物件所在地', '住所（物件）']));
    var suumo = (body.match(/https?:\/\/(?:www\.)?suumo\.jp\/[^\s"'<>）)]+/) || [''])[0];
    lines.push('*SUUMO物件ページ：* ' + (suumo ? '<' + suumo + '>' : '不明'));

    lines.push('');
    var comment = pickBlock_(body, ['お問い合わせ内容', 'お問合せ内容', '問い合わせ内容', '問合せ内容', 'コメント', 'お客様コメント', 'ご質問・ご要望', 'ご要望', '備考', 'メッセージ']);
    lines.push(':speech_balloon: *お問い合わせ内容*');
    lines.push(comment ? comment.split('\n').map(function (l) { return '> ' + l; }).join('\n') : '不明');
    lines.push('');
  }

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

/** 動作確認用: 直近のJDS反響メールの本文そのものと、通知文をログに出す(Slackには送らない) */
function previewLatestJdsRaw() {
  var threads = GmailApp.search('from:' + JDS_SENDER + ' newer_than:60d', 0, 10);
  for (var i = 0; i < threads.length; i++) {
    var m = threads[i].getMessages().pop();
    if (!isJdsInquiry_(m.getSubject())) continue;
    Logger.log('件名: ' + m.getSubject() + '\n----- 本文 -----\n' + m.getPlainBody());
    Logger.log('----- 通知文 -----\n' + buildText_(m));
    return;
  }
  Logger.log('反響メールなし');
}
