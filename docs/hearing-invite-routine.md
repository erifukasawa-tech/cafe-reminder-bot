# 売買ヒアリングに社長を自動招待するRoutine

毎朝7:52(JST)に、`info@naikenboys.co.jp` カレンダー上の今後の売買ヒアリング予定を確認し、社長(中島さん `sho_nakajima@naikenboys.co.jp`)が未招待のものに追加します。

## 作成手順(claude.ai の Routines 画面)

`create_trigger` API ではこの組織の設定によりコネクタを持たせられないため、claude.ai の Routines 画面から手動で作成してください。

- スケジュール: 毎日 7:52 (Asia/Tokyo)
- コネクタ: **Google Calendar のみ ON**
- プロンプト: 下記をそのまま貼り付け

## プロンプト

```
あなたは株式会社ないけんぼーいずのバックオフィス(深澤)の代理で、売買ヒアリングの予定に社長を招待する作業を行います。

## 手順
1. Google Calendar コネクタで、カレンダー info@naikenboys.co.jp の予定を「現在時刻〜90日後」まで list_events(orderBy=startTime, pageSize=250、nextPageTokenがあれば全ページ)で取得する。結果が大きくファイルに保存された場合は jq で処理する。
2. 次のいずれかに当てはまる予定を「売買ヒアリング」とみなす:
   - タイトルに renewal_BUY / BUY_ / : BUY / SELL / 売買 / 売却 / 購入 を含む(大文字小文字無視。SHIBUYA など単語の一部の BUY は除外)
   - タイトルに ヒアリング(再ヒアリング・オンラインヒアリング含む)を含む
   除外: タイトルに RENT / 賃貸 / 勉強会 / 社長カフェ / ばっちカフェ を含むもの、キャンセル済みの予定、開始時刻が既に過ぎた予定。
3. 対象のうち参加者に sho_nakajima@naikenboys.co.jp が含まれていない予定について、update_event(calendarId=info@naikenboys.co.jp, eventId, addedAttendees=[{"email":"sho_nakajima@naikenboys.co.jp"}])で社長を追加する。他の参加者・説明文・時刻などは一切変更しない。社長が辞退(declined)済みの予定には再追加しない。
4. 最後に、追加した予定(日時・タイトル)と、判定に迷ってスキップした予定を一覧で報告する。追加対象がなければ「追加なし」とだけ報告する。
```
