# SUUMO 反響・内見予約 → Slack 通知

info@naikenboys.co.jp に届く SUUMO の反響メールと内見予約メールを、
`#2-ヒアリング予約通知__今は売買のみ` に自動で通知する Google Apps Script です。

## 反響（JDS）: `system@jds.suumo.jp`
- [リクルートＪＤＳ]反響お知らせメール → これまでと同じ「JDS反響通知が届きました」の体裁で通知

作成元がわからなくなっていた旧JDS反響通知の代わりです。旧通知が動き続けている間は、反響が2回通知されます。

## 内見予約: `reserve-info@kr-hometour.suumo.jp`（差出人が同じものはすべて対象）
- 【SUUMO】見学予約のお申し込みがありました（即時予約）
- 【SUUMO】仮予約のお申し込みがありました
- 【要確認】案内日時の変更がありました
- その他、キャンセル通知など

Slack に載せるのは受付日時・案内日時・集合場所・物件名・価格・お客様氏名・予約詳細URLです。
電話番号・メールアドレス・住所は載せません（公開チャンネルのため）。

## 設定手順

1. info@naikenboys.co.jp のアカウントで https://script.google.com を開き、新しいプロジェクトを作る。
2. `Code.gs` の中身をそのまま貼り付けて保存する。
3. Slack の Incoming Webhook を `#2-ヒアリング予約通知__今は売買のみ` 向けに用意する（JDS反響通知で使っている Webhook があればそれを流用して構いません）。
4. コードの一番上の `var SLACK_WEBHOOK_URL = '';` の `''` の間に Webhook の URL を貼って保存する（このリポジトリには実際のURLを書かないこと）。
5. `previewLatest` を実行して、ログに出る通知文を確認する（この段階では Slack には送られません）。
6. `setup` を1回だけ実行する（Gmail・外部通信の権限を許可する）。
   - 今届いているメールは通知済みになり、以後5分おきに新着だけが通知されます。

## 現在の設定場所（2026-09-29 設定）

- Apps Script: info@ の Google アカウントのプロジェクト「SUUMO通知」（トリガー: `checkSuumoReservations` 5分おき）
- Slack Webhook: api.slack.com/apps のアプリ「スーモ反響通知」→ Incoming Webhooks に 2026-09-29 に追加した URL
- 同じアプリに元からある Webhook URL は、作成元不明の旧JDS反響通知が使っているとみられる。
  新しい通知の稼働を確認後、元からある方を Remove すると旧通知が止まり、二重通知が解消する。
