# Zoom録画アーカイブ Routine

毎朝、深澤さんのZoomクラウド録画のうち前日までの分について「要約・ネクストアクション・トピック別要約・文字起こし全文・録画リンク」をまとめたGoogleドキュメントを作り、共有ドライブの `ZOOM自動保存/eri_fukasawa@naikenboys.co.jp/` フォルダ（ID: `1Jd6n00NAbNm1O1MhTxaC8jxSFqmDaN6M`）に保存します。

動画ファイル（mp4）本体はこのRoutineでは保存しません。動画はZoomクラウドに残り、ドキュメント内の録画リンクから再生できます。同じフォルダにmp4/vttを保存している既存の自動保存の仕組み（毎時6分に動いているもの）とは別物です。

## 設定

| 項目 | 値 |
|---|---|
| 実行タイミング | 毎日 8:47 JST |
| 必要なコネクタ | Zoom for Claude、Google Drive |
| 保存先 | 共有ドライブ「ZOOM自動保存」/ eri_fukasawa@naikenboys.co.jp |
| ファイル名 | `YYYYMMDD_{会議名}_文字起こし・要約`（Googleドキュメント） |

## 手動で作成する場合の手順

Claude Codeの `create_trigger` でコネクタを付けられなかった場合は、claude.ai の Routines 画面で次の内容で作成してください。

1. 「新しいRoutine」→ 毎日 8:47（Asia/Tokyo）
2. コネクタで **Zoom for Claude** と **Google Drive** をON
3. 下のプロンプトをそのまま貼り付け

## プロンプト

```
あなたは毎朝、深澤恵利（eri_fukasawa@naikenboys.co.jp）のZoomクラウド録画をGoogle Driveにアーカイブする担当です。以下の手順を最後まで実行してください。途中でユーザーに質問せず、判断に迷うものはスキップして最後の報告に書いてください。

## 保存先
- Google Driveフォルダ ID: 1Jd6n00NAbNm1O1MhTxaC8jxSFqmDaN6M（共有ドライブ「ZOOM自動保存」/ eri_fukasawa@naikenboys.co.jp）

## 手順
1. Zoomの recordings_list を、from=今日(UTC)の3日前、to=今日(UTC) で呼び、録画一覧を取得する（page_size=50、next_page_token があれば続けて取得）。
2. 各録画について、開始日時を日本時間(JST)に直した日付で YYYYMMDD を作り、ファイル名を「YYYYMMDD_{topic}_文字起こし・要約」とする。
3. Google Drive の search_files で `parentId = '1Jd6n00NAbNm1O1MhTxaC8jxSFqmDaN6M' and title contains 'YYYYMMDD_'` を検索し、同じファイル名のドキュメントが既にあればその録画はスキップする（重複作成しない）。
4. recording_files に TRANSCRIPT（audio_transcript）も SUMMARY も無い録画はスキップする（処理中の可能性があるので翌日以降に再挑戦される）。
5. get_recording_resource を meetingId=録画のuuid、types="summary,nextStep" で呼び、全体要約・トピック別要約・ネクストアクションを取得する。
6. get_recording_resource を meetingId=録画のuuid、types="transcript" で呼ぶ。結果が大きすぎてファイルに保存された場合は、Bashで jq を使って次の形に整形する（連続する同じ話者の発言は1行にまとめ、時刻は秒まで）:
   jq -r '.transcripts[0].timeline[] | [.ts[0:8], .display_name, .text] | @tsv' <保存先ファイル> | awk -F'\t' '{ if ($2==p) { line=line $3 } else { if (line!="") print line; line="[" $1 "] " $2 "：" $3; p=$2 } } END{print line}'
   整形結果は Read ツールで全行読むこと。
7. 次のMarkdownで本文を組み立て、Google Drive の create_file で作成する（title=手順2のファイル名、parentId=上記フォルダID、contentMimeType="text/markdown"、textContent=本文）。文字起こしは要約・省略せず全行を載せ、各行の間に空行を入れる。要約やネクストアクションはZoomの内容をそのまま使い、自分で内容を足さない。

   # {topic}

   - 日時：YYYY/MM/DD（曜）HH:MM〜HH:MM JST（{duration}分）
   - 参加者（発言者）：{文字起こしに出てくる発言者名を「名 姓」表記は「姓名」に直して列挙}
   - 録画（Zoom）：{share_url}
   - ミーティングID：{id}

   ## 全体要約
   {overall_summary}

   ## ネクストアクション
   - {next_steps の各 text}

   ## トピック別要約
   **MM:SS {label}**　{summary}   （label と summary が空の項目は省く。各項目の間に空行）

   ## 文字起こし（Zoom自動文字起こし・連続する同一話者の発言はまとめています）
   [hh:mm:ss] 話者：発言

   ---
   このドキュメントはClaudeがZoomクラウド録画から自動作成しました。

8. 作成したら read_file_content で中身が入っていることを確認する。空なら1回だけ作り直す。

## 最後の報告
作成したドキュメント（タイトルとURL）、スキップした録画とその理由、エラーを箇条書きで報告して終了する。録画が0件ならその旨だけ報告する。Slackやメールなど他への送信はしない。
```
