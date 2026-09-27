/**
 * ==================================================
 * ヒアリング完了アンケート送信（手動ボタン版）
 * ==================================================
 *
 * 「売買管理」シートで行を選択し、メニューから実行すると
 *  ①その顧客にGmailでアンケートを送信
 *  ②「アンケート送付日」列（無ければ自動作成）に送信日時を記録
 *  ③Slackの「ヒアリング予約通知」スレッド（TimeRexの「〇〇さんが予定を追加しました。」投稿）に
 *    「アンケート送付済み」と返信
 * を行う。P列が「21_ヒアリング済」の行のみ送信可能。
 *
 * 自動送信は行わない（ボタンを押したときだけ動く）。
 *
 * 【事前準備】
 * 1. スクリプトプロパティに SLACK_BOT_TOKEN を設定（未設定の場合）
 *    - 必要なOAuthスコープ: channels:history（or groups:history）, chat:write
 *    - そのBotを #2-ヒアリング予約通知 チャンネルに招待しておく（未招待だと not_in_channel エラー）
 * 2. このスクリプトを保存 → シートを開き直すと「アンケート送付」メニューが追加される
 */

// ===== 設定 =====
const SHEET_NAME = '売買管理';
const HEADER_ROW = 6;       // 見出し行（「#」「反響日」「担当」…の行）
const FIRST_DATA_ROW = 7;   // データの1行目
const STATUS_COL = 16;      // P列：ステータス
const NAME_COL = 9;         // I列：顧客名
const EMAIL_COL = 105;      // DA列：メールアドレス
const STATUS_VALUE = '21_ヒアリング済';

const SLACK_CHANNEL_ID = 'C08MNFSF37C'; // #2-ヒアリング予約通知__今は売買のみ
// TimeRexの予約通知（スレッドの親）は「{顧客名}さんが予定を追加しました。」で始まる。
// 「ヒアリング」を含むかどうかで探すと、【TimeRex取込】のまとめ投稿など別の投稿に当たってしまうため、この文言で特定する。
const SLACK_NOTICE_SUFFIX = 'さんが予定を追加';
const SLACK_MAX_MESSAGES = 1000;        // 直近から遡って探す最大件数
const SENT_KEYWORD = 'アンケート送付済み';

const SURVEY_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLScB4ouESWigMYzxGmjSp4g0mSG1pOV6mlaTrYw0J9V3F9l2YA/viewform';
const MAIL_SUBJECT = 'ヒアリング満足度アンケートのご協力のお願い【株式会社ないけんぼーいず】';
const SENT_DATE_HEADER = 'アンケート送付日';

function getSlackToken_() {
  const token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token) throw new Error('スクリプトプロパティに SLACK_BOT_TOKEN が設定されていません。');
  return token;
}

/**
 * スプレッドシートを開いたときにカスタムメニューを追加
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('アンケート送付')
    .addItem('選択中の行に送信', 'sendSurveyManual')
    .addToUi();
}

/**
 * 選択中の行の顧客にアンケートを送信する（P列が「ヒアリング済み」の行のみ）
 */
function sendSurveyManual() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const activeSheet = SpreadsheetApp.getActiveSheet();

  if (activeSheet.getName() !== SHEET_NAME) {
    ui.alert(`「${SHEET_NAME}」シート上で実行してください。`);
    return;
  }

  const row = sheet.getActiveCell().getRow();
  if (row < FIRST_DATA_ROW) {
    ui.alert('データ行を選択してください。');
    return;
  }

  const status = sheet.getRange(row, STATUS_COL).getValue();
  const name = String(sheet.getRange(row, NAME_COL).getValue()).trim();
  const email = String(sheet.getRange(row, EMAIL_COL).getValue()).trim();

  if (status !== STATUS_VALUE) {
    ui.alert(`このお客様（${name}）はステータスが「${STATUS_VALUE}」ではないため送信できません。`);
    return;
  }
  if (!email) {
    ui.alert(`このお客様（${name}）のメールアドレスが未入力です。`);
    return;
  }

  const dateCol = getOrCreateSentDateColumn_(sheet);
  const sentAt = sheet.getRange(row, dateCol).getValue();
  const alreadySentNote = sentAt
    ? `\n\n※このお客様には ${Utilities.formatDate(new Date(sentAt), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')} に送付済みです。再送しますか？`
    : '';

  const confirm = ui.alert(
    '送信確認',
    `${name} 様（${email}）にアンケートを送信します。よろしいですか？${alreadySentNote}`,
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  // ① メール送信 → ② 送付日を記録（Slack側で失敗しても二重送信を防ぐため、メール直後に記録する）
  try {
    sendSurveyEmail_(email, name);
    sheet.getRange(row, dateCol).setValue(new Date());
  } catch (e) {
    ui.alert('メール送信でエラーが発生しました（送信されていません）：' + e.message);
    return;
  }

  // ③ Slackのヒアリング予約通知スレッドに返信
  let slackNote;
  try {
    const threadTs = findHearingThreadTs_(name);
    if (threadTs) {
      postSlackReply_(threadTs, SENT_KEYWORD);
      slackNote = '\nSlackのヒアリング予約通知スレッドに「' + SENT_KEYWORD + '」と返信しました。';
    } else {
      slackNote = `\n※Slackで「${name}${SLACK_NOTICE_SUFFIX}しました」の予約通知が見つからなかったため、Slackへの返信は行っていません。手動で返信してください。`;
    }
  } catch (e) {
    slackNote = '\n※メールは送信済みですが、Slackへの返信でエラーが発生しました。手動で返信してください：' + e.message;
  }

  ui.alert(`${name} 様にアンケートを送信しました。` + slackNote);
}

/**
 * 見出し行から「アンケート送付日」列を探す。無ければ一番後ろに新規作成して列番号を返す
 */
function getOrCreateSentDateColumn_(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0];
  const existing = headers.indexOf(SENT_DATE_HEADER);
  if (existing !== -1) {
    return existing + 1; // indexOfは0始まりなので+1
  }
  const newCol = lastCol + 1;
  sheet.getRange(HEADER_ROW, newCol).setValue(SENT_DATE_HEADER);
  return newCol;
}

/**
 * アンケートメールを送信
 */
function sendSurveyEmail_(email, name) {
  const body =
    `${name} 様\n\n` +
    `お世話になっております。\n` +
    `株式会社ないけんぼーいずアシスタントの横山でございます。\n\n` +
    `先日はお忙しい中、ヒアリングのお時間をいただき誠にありがとうございました！\n\n` +
    `現在、サービス品質向上のため、ヒアリングに関する満足度アンケート（所要時間：約1分）へのご協力をお願いしております。\n` +
    `本アンケートでいただいたご意見は、今後のご提案内容やご対応の改善に直接反映させていただきます。\n\n` +
    `またご回答いただいた方には特典として、すぐに実務で使える以下の資料㊙️をお渡ししております。\n\n` +
    `・賃貸物件の退去費用ぼったくり防衛ガイド\n` +
    `・物件購入のための資産性見極めガイド\n\n` +
    `どちらも今後のお住まい選びにおいて実践的にご活用いただける内容となっております。\n\n` +
    `なお、フォーム送信後の画面にてダウンロードURLが表示されます。\n` +
    `アンケートは匿名形式のため、率直なご意見をいただけますと幸いです。\n\n` +
    `いただいたご意見をもとに、よりご満足いただけるご提案をさせていただきますので、ぜひご協力をお願いいたします。\n\n` +
    `★アンケートはこちらから★\n` +
    `${SURVEY_FORM_URL}\n\n` +
    `−−−−−−−−−−−−−−−−−−−−−−−−−−−−\n` +
    `株式会社ないけんぼーいず　\n` +
    `〒150-0043\n` +
    `東京都渋谷区道玄坂1-20-3 COERU SHIBUYA8階\n` +
    `TEL 03-6455-2402 / FAX 03-6455-2403`;

  GmailApp.sendEmail(email, MAIL_SUBJECT, body);
}

/** 空白（半角・全角）を取り除く。シートとTimeRexで「山田 太郎」「山田太郎」の表記揺れがあっても一致させるため */
function normalize_(s) {
  return String(s || '').replace(/[\s　]/g, '');
}

/**
 * Slackメッセージの本文を集める。TimeRexなどのBot投稿は text が空で
 * attachments / blocks にだけ本文が入っていることがあるため、全部つなげて見る
 */
function messageText_(m) {
  const parts = [m.text || ''];
  (m.attachments || []).forEach(a => {
    parts.push(a.pretext || '', a.title || '', a.text || '', a.fallback || '');
    (a.fields || []).forEach(f => parts.push(f.title || '', f.value || ''));
  });
  const walk = node => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    if (typeof node.text === 'string') parts.push(node.text);
    ['text', 'elements', 'fields'].forEach(k => {
      if (node[k] && typeof node[k] === 'object') walk(node[k]);
    });
  };
  walk(m.blocks);
  return parts.join('\n');
}

/**
 * Slackチャンネル内から、その顧客のTimeRex予約通知（「{顧客名}さんが予定を追加しました。」）のtsを探す
 * 直近のメッセージから遡って検索し、最初に見つかったもの（＝一番新しい予約）を返す
 */
function findHearingThreadTs_(name) {
  const token = getSlackToken_();
  const needle = normalize_(name) + SLACK_NOTICE_SUFFIX;
  let cursor = null;
  let searched = 0;

  do {
    const url = 'https://slack.com/api/conversations.history?' +
      `channel=${SLACK_CHANNEL_ID}&limit=200` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');

    const res = UrlFetchApp.fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true
    });
    const json = JSON.parse(res.getContentText());

    if (!json.ok) throw new Error('Slack API エラー（conversations.history）：' + json.error);

    const match = json.messages.find(m => normalize_(messageText_(m)).includes(needle));
    if (match) return match.thread_ts || match.ts;

    searched += json.messages.length;
    cursor = json.response_metadata && json.response_metadata.next_cursor;
  } while (cursor && searched < SLACK_MAX_MESSAGES);

  return null;
}

/**
 * Slackスレッドに返信を投稿
 */
function postSlackReply_(threadTs, text) {
  const token = getSlackToken_();
  const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      thread_ts: threadTs,
      text: text
    }),
    muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText());
  if (!json.ok) throw new Error('Slack API エラー（chat.postMessage）：' + json.error);
}
