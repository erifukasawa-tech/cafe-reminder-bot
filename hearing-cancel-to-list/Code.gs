/**
 * ヒアリングキャンセル → キャンセルリスト 自動転記
 *
 * 5分おきに #2-ヒアリング予約通知__今は売買のみ を確認し、
 * TimeRex の「〇〇さんが予定をキャンセルしました」通知を見つけたら、
 *   1. 案件管理シート「売買管理」から案件番号・担当・反響日・流入経路・LstepURL を引き、
 *   2. キャンセルリスト「キャンセル追客リスト」の2行目（いちばん上）に1行追加し、
 *   3. 通知のスレッドに「追加しました」と返信する。
 *
 * セットアップ手順は README.md を参照。
 */

// ===== 設定 =====
const CONFIG = {
  SLACK_CHANNEL_ID: 'C08MNFSF37C', // #2-ヒアリング予約通知__今は売買のみ
  CANCEL_KEYWORD: 'さんが予定をキャンセルしました',

  DEAL_SPREADSHEET_ID: '1OOOSY0Y_QDDByjkiTI9om7BOq68UfD8OdDMLqKFU6B0', // 案件管理シート
  DEAL_SHEET_NAME: '売買管理',
  DEAL_HEADER_ROW: 6,

  CANCEL_SPREADSHEET_ID: '1ARR67SjdG-CYfPemeaUqto6u_Ltc4uhVtp4hGkDary4', // キャンセルリスト
  CANCEL_SHEET_NAME: 'キャンセル追客リスト',
  CANCEL_HEADER_ROW: 1,

  TIMEREX_EVENT_URL: 'https://timerex.net/user/event/',
  TRIGGER_MINUTES: 5,
};

// ===== 入口 =====

/** 最初に1回だけ手動実行：5分おきのトリガーを作り、今より前の通知は対象外にする */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SLACK_BOT_TOKEN')) {
    throw new Error('スクリプトプロパティ SLACK_BOT_TOKEN を先に設定してください');
  }
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'run')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('run').timeBased().everyMinutes(CONFIG.TRIGGER_MINUTES).create();
  if (!props.getProperty('LAST_TS')) {
    props.setProperty('LAST_TS', String(Date.now() / 1000));
  }
  Logger.log('セットアップ完了。これ以降のキャンセル通知が自動で転記されます。');
}

/** 試し実行：直近N日分の通知を読み、何を書き込むかをログに出すだけ（書き込み・返信はしない） */
function dryRun() {
  const days = 7;
  const oldest = String(Date.now() / 1000 - days * 86400);
  processSince_(oldest, { dryRun: true });
}

/** 過去分の取り込み：直近N日分を実際に転記する（重複は自動でスキップ） */
function backfill() {
  const days = 7;
  const oldest = String(Date.now() / 1000 - days * 86400);
  processSince_(oldest, { dryRun: false });
}

/** トリガーから5分おきに呼ばれる */
function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const oldest = props.getProperty('LAST_TS') || String(Date.now() / 1000 - 3600);
    const newest = processSince_(oldest, { dryRun: false });
    if (newest) props.setProperty('LAST_TS', newest);
  } finally {
    lock.releaseLock();
  }
}

// ===== 本体 =====

/** oldest より新しい通知を処理し、処理した中で最新の ts を返す */
function processSince_(oldest, opts) {
  const messages = fetchChannelMessages_(oldest);
  messages.sort((a, b) => Number(a.ts) - Number(b.ts)); // 古い順に処理
  let newest = null;

  for (const msg of messages) {
    newest = msg.ts;
    if (msg.thread_ts && msg.thread_ts !== msg.ts) continue; // スレッド内の返信は対象外
    const parsed = parseCancelMessage_(msg);
    if (!parsed) continue;

    const deal = findDeal_(parsed);
    const result = upsertCancelRow_(parsed, deal, opts);
    Logger.log(JSON.stringify({ parsed, deal, result }));

    if (!opts.dryRun) {
      postSlackReply_(msg.ts, buildReplyText_(parsed, deal, result));
    }
  }
  return newest;
}

/**
 * TimeRex のキャンセル通知を読み取る。キャンセル通知でなければ null。
 * 例:
 *   安保一希さんが予定をキャンセルしました。
 *   2026年11月16日 (月) 12:00 - 13:30（Asia/Tokyo）
 *   ...
 *   *参加者:*
 *   仕切悠彦
 */
function parseCancelMessage_(msg) {
  const text = collectText_(msg);
  const nameMatch = text.match(new RegExp('^\\s*\\**\\s*(.+?)' + CONFIG.CANCEL_KEYWORD, 'm'));
  if (!nameMatch) return null;

  const dateMatch = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const hearingDate = dateMatch
    ? `${dateMatch[1]}/${pad2_(dateMatch[2])}/${pad2_(dateMatch[3])}`
    : '';

  const participantMatch = text.match(/参加者[:：]\**\s*\n\s*([^\n]+)/);
  const participant = participantMatch ? participantMatch[1].replace(/\*/g, '').trim() : '';

  // 「詳細を表示」ボタン等に入っているイベントURLからイベントIDを取る
  const raw = JSON.stringify(msg);
  const eventMatch = raw.match(/timerex\.net\/(?:slack|user)\/event\/([0-9A-Za-z]+)/);
  const eventId = eventMatch ? eventMatch[1] : '';

  return {
    ts: msg.ts,
    customerName: nameMatch[1].replace(/\*/g, '').trim(),
    hearingDate,
    participant,
    eventId,
    cancelDate: formatDate_(new Date(Number(msg.ts) * 1000)),
  };
}

/** 案件管理シート「売買管理」から該当案件を探す。見つからなければ null */
function findDeal_(parsed) {
  const sheet = SpreadsheetApp.openById(CONFIG.DEAL_SPREADSHEET_ID).getSheetByName(CONFIG.DEAL_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(CONFIG.DEAL_HEADER_ROW, 1, 1, lastCol).getDisplayValues()[0];
  const col = name => headers.findIndex(h => String(h).trim() === name);
  const idx = {
    no: col('#'),
    responseDate: col('反響日'),
    owner: col('担当'),
    channel: col('獲得方法'),
    name: col('顧客名'),
    url: col('URL'),
    hearingDate: col('ヒアリング日'),
    note: col('備考'),
    eventId: col('イベントID'),
  };
  if (idx.name < 0) throw new Error('売買管理シートに「顧客名」列が見つかりません');

  const numRows = lastRow - CONFIG.DEAL_HEADER_ROW;
  if (numRows <= 0) return null;
  const rows = sheet.getRange(CONFIG.DEAL_HEADER_ROW + 1, 1, numRows, lastCol).getDisplayValues();
  const get = (row, key) => (idx[key] >= 0 ? String(row[idx[key]] || '').trim() : '');

  const target = normalizeName_(parsed.customerName);
  let hit = null;
  let matchedBy = '';

  // 1. イベントIDで一致
  if (parsed.eventId && idx.eventId >= 0) {
    hit = rows.find(r => get(r, 'eventId') === parsed.eventId);
    if (hit) matchedBy = 'イベントID';
  }
  // 2. 氏名＋ヒアリング日で一致
  if (!hit && parsed.hearingDate) {
    hit = rows.find(r => normalizeName_(get(r, 'name')) === target && get(r, 'hearingDate') === parsed.hearingDate);
    if (hit) matchedBy = '氏名＋ヒアリング日';
  }
  // 3. 氏名だけで一致（複数あれば反響日が新しいもの）
  if (!hit) {
    const candidates = rows.filter(r => normalizeName_(get(r, 'name')) === target);
    if (candidates.length) {
      candidates.sort((a, b) => get(b, 'responseDate').localeCompare(get(a, 'responseDate')));
      hit = candidates[0];
      matchedBy = candidates.length > 1 ? '氏名のみ（同名複数・要確認）' : '氏名のみ';
    }
  }
  if (!hit) return null;

  const noteMatch = get(hit, 'note').match(/流入[:：]([^｜|\n]+)/);
  return {
    no: get(hit, 'no'),
    owner: get(hit, 'owner'),
    responseDate: get(hit, 'responseDate'),
    inflow: noteMatch ? noteMatch[1].trim() : get(hit, 'channel'),
    name: get(hit, 'name'),
    lstepUrl: get(hit, 'url'),
    eventId: get(hit, 'eventId'),
    matchedBy,
  };
}

/** キャンセルリストに追加する。すでにあれば追加しない */
function upsertCancelRow_(parsed, deal, opts) {
  const sheet = SpreadsheetApp.openById(CONFIG.CANCEL_SPREADSHEET_ID).getSheetByName(CONFIG.CANCEL_SHEET_NAME);
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(CONFIG.CANCEL_HEADER_ROW, 1, 1, lastCol).getDisplayValues()[0].map(h => String(h).trim());
  const col = name => headers.indexOf(name);

  const eventId = parsed.eventId || (deal && deal.eventId) || '';
  const timerexUrl = eventId ? CONFIG.TIMEREX_EVENT_URL + eventId : '';
  const dealNo = deal ? deal.no : '';
  const name = deal ? deal.name : parsed.customerName;

  // 重複チェック（TimeRexURL／案件番号＋ヒアリング日／氏名＋ヒアリング日）
  const firstDataRow = CONFIG.CANCEL_HEADER_ROW + 1;
  const numRows = sheet.getLastRow() - CONFIG.CANCEL_HEADER_ROW;
  if (numRows > 0) {
    const rows = sheet.getRange(firstDataRow, 1, numRows, lastCol).getDisplayValues();
    const at = (r, h) => (col(h) >= 0 ? String(r[col(h)] || '').trim() : '');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const sameEvent = eventId && at(r, 'TimeRexURL').indexOf(eventId) >= 0;
      const sameDeal = dealNo && at(r, '案件番号') === dealNo && at(r, '当初ヒアリング日') === parsed.hearingDate;
      const sameName = normalizeName_(at(r, 'お客様名')) === normalizeName_(name) && at(r, '当初ヒアリング日') === parsed.hearingDate;
      if (sameEvent || sameDeal || sameName) {
        const rowNum = firstDataRow + i;
        // キャンセル連絡日が空なら埋めておく
        if (!opts.dryRun && col('キャンセル連絡日') >= 0 && !at(r, 'キャンセル連絡日')) {
          sheet.getRange(rowNum, col('キャンセル連絡日') + 1).setValue(parsed.cancelDate);
        }
        return { action: 'exists', row: rowNum };
      }
    }
  }

  const values = {
    '案件番号': dealNo,
    '担当': deal ? deal.owner : parsed.participant,
    '反響日': deal ? deal.responseDate : '',
    '流入経路': deal ? deal.inflow : '',
    '当初ヒアリング日': parsed.hearingDate,
    'お客様名': name,
    'キャンセル理由': '',
    'キャンセル連絡日': parsed.cancelDate,
    'TimeRexURL': timerexUrl,
    'LstepURL': deal ? deal.lstepUrl : '',
    'リスケURL送付日': '',
    '状況・お客様情報': buildStatusNote_(deal),
    'アポ取得': false,
    '追客ストップ': false,
  };
  const row = headers.map(h => (h in values ? values[h] : ''));

  if (opts.dryRun) return { action: 'would_add', row: firstDataRow, values };

  // いちばん上（見出しのすぐ下）に挿入し、下の行の書式・入力規則（チェックボックス等）を写す
  sheet.insertRowBefore(firstDataRow);
  const newRange = sheet.getRange(firstDataRow, 1, 1, lastCol);
  const below = sheet.getRange(firstDataRow + 1, 1, 1, lastCol);
  below.copyTo(newRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  below.copyTo(newRange, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  newRange.setValues([row]);
  return { action: 'added', row: firstDataRow };
}

function buildStatusNote_(deal) {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M/d');
  let note = `【自動追加 ${today}】TimeRexのキャンセル通知から追加しました。キャンセル理由・リスケURL送付日を記入してください。`;
  if (!deal) note += '案件管理シートで該当案件が見つからなかったため、案件番号・担当・反響日などは空欄です。';
  else if (deal.matchedBy.indexOf('要確認') >= 0) note += '同名の案件が複数あったため、案件番号が正しいか確認してください。';
  return note;
}

function buildReplyText_(parsed, deal, result) {
  const link = `<https://docs.google.com/spreadsheets/d/${CONFIG.CANCEL_SPREADSHEET_ID}/edit|キャンセルリスト>`;
  const who = deal
    ? `#${deal.no} ${deal.name} 様（担当: ${deal.owner || '未定'}）`
    : `${parsed.customerName} 様`;
  if (result.action === 'exists') {
    return `:memo: ${who} はすでに${link}の${result.row}行目にあります（自動転記はスキップしました）。`;
  }
  let text = `:memo: ${who} を${link}に自動で追加しました。\nキャンセル理由とリスケURL送付日の記入をお願いします。`;
  if (!deal) text += '\n:warning: 案件管理シートで該当案件が見つからなかったため、案件番号・担当などは空欄です。';
  else if (deal.matchedBy.indexOf('要確認') >= 0) text += '\n:warning: 同名の案件が複数あったため、案件番号が正しいか確認してください。';
  return text;
}

// ===== Slack API =====

function fetchChannelMessages_(oldest) {
  const all = [];
  let cursor = '';
  do {
    const params = {
      channel: CONFIG.SLACK_CHANNEL_ID,
      oldest: oldest,
      limit: '200',
      inclusive: 'false',
    };
    if (cursor) params.cursor = cursor;
    const res = slackApi_('conversations.history', params, 'get');
    all.push(...(res.messages || []));
    cursor = res.has_more && res.response_metadata ? res.response_metadata.next_cursor : '';
  } while (cursor);
  return all;
}

function postSlackReply_(threadTs, text) {
  slackApi_('chat.postMessage', {
    channel: CONFIG.SLACK_CHANNEL_ID,
    thread_ts: threadTs,
    text: text,
    unfurl_links: false,
  }, 'post');
}

function slackApi_(method, params, httpMethod) {
  const token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token) throw new Error('スクリプトプロパティ SLACK_BOT_TOKEN が未設定です');
  let url = 'https://slack.com/api/' + method;
  const options = {
    method: httpMethod,
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  };
  if (httpMethod === 'get') {
    url += '?' + Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  } else {
    options.contentType = 'application/json; charset=utf-8';
    options.payload = JSON.stringify(params);
  }
  const res = JSON.parse(UrlFetchApp.fetch(url, options).getContentText());
  if (!res.ok) throw new Error(`Slack API ${method} エラー: ${res.error}`);
  return res;
}

// ===== 小道具 =====

/** text・blocks・attachments の文字をまとめて1つのテキストにする */
function collectText_(msg) {
  const parts = [];
  if (msg.text) parts.push(msg.text);
  const walk = node => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') {
      if (typeof node.text === 'string') parts.push(node.text);
      if (typeof node.fallback === 'string') parts.push(node.fallback);
      Object.keys(node).forEach(k => { if (k !== 'text' && typeof node[k] === 'object') walk(node[k]); });
      if (node.text && typeof node.text === 'object') walk(node.text);
    }
  };
  walk(msg.blocks);
  walk(msg.attachments);
  return parts.join('\n');
}

/** 照合用に氏名をそろえる（空白・「様」「さん」を取る） */
function normalizeName_(s) {
  return String(s || '').replace(/[\s　]/g, '').replace(/(様|さん)$/, '');
}

function formatDate_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd');
}

function pad2_(n) {
  return ('0' + n).slice(-2);
}
