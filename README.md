# EDCB MCP Server

EDCBをLLMから操作するためのMCPサーバー。番組情報取得、予約管理などが可能です。

## 前提

EDCB（EpgTimerSrv）にTCP接続（既定のポート4510。EpgTimerNWと同じ接続方法）で接続します。WebUIやMaterial WebUIは要りません。

EDCB側では、EpgTimerSrvの設定「ネットワーク接続を許可する (EpgTimerNW用)」（`EnableTCPSrv=1`）を有効にし、アクセス制御（`TCPAccessControlList`）でMCPサーバーを動かすマシンのIPを許可してください。

TCP接続は、HTTP APIより数倍速く、複数チャンネルの番組表の一括取得やEDCB側での番組検索ができます。

> [!WARNING]
> EDCBのTCP接続には認証がなく、接続元のIPアドレスでしか制限できません。アクセス制御で許可した範囲からは、誰でも予約の変更・削除ができます。許可する範囲は信頼できるネットワークに限ってください。

接続を確認するには `ping` ツールを使います。

## ビルド

```bash
npm install
npm run build
```

## Claude Desktop 設定

`~/Library/Application Support/Claude/claude_desktop_config.json` に追加:

```json
{
  "mcpServers": {
    "edcb": {
      "command": "node",
      "args": ["/path/to/EDCB-MCPServer/dist/index.js"],
      "env": {
        "EDCB_HOST": "192.168.1.x"
      }
    }
  }
}
```

## 利用可能なツール

| ツール | 説明 |
|--------|------|
| `ping` | EDCBサーバーへの接続確認 |
| `get_services` | チャンネル一覧取得 |
| `get_epg` | 特定チャンネルの番組表取得 |
| `get_event_info` | 番組詳細取得（出演者などの詳細情報を含む） |
| `search_events` | 番組検索（EDCBの検索機能を使用。空白区切りでAND、除外キーワード・タイトルのみ検索に対応） |
| `get_reserves` | 録画予約一覧取得 |
| `add_reserve` | 録画予約追加（優先度・マージンなどを指定可。予約済みの番組は追加しない） |
| `set_reserve_enabled` | 録画予約の有効/無効切り替え |
| `delete_reserve` | 録画予約削除 |
| `change_reserve` | 録画予約設定変更（指定した項目だけを変更） |
| `get_rec_info` | 録画済み番組一覧取得（キーワード・期間・問題のある録画で絞り込み可） |
| `get_auto_add` | 自動予約（EPGキーワード）一覧取得 |

## 使用例

自然言語でEDCBを操作できます。

### 番組を検索して予約

「推しの子」の最終話を自然言語で検索し、放送チャンネルを選んで録画予約。

![番組検索と予約](docs/images/スクリーンショット%202026-03-25%2016.44.28.png)

### 予約状況の確認

録画予約や自動予約の確認もチャット形式で行えます。

![予約確認](docs/images/スクリーンショット%202026-03-25%2016.45.47.png)

### EPGを使った番組検索

今後放送されるプロ野球の生中継一覧をEPGから検索して表示。

![EPG番組検索](docs/images/スクリーンショット%202026-03-25%2016.48.27.png)

### APIリファレンス

```
# チャンネル一覧（地上波のみ）
get_services(network="地上波")

# NHK総合の番組表を取得
get_epg(onid=32272, tsid=32272, sid=30720)

# 番組を予約
add_reserve(onid=32272, tsid=32272, sid=30720, eid=20202)

# 優先度と開始マージンを指定して予約
add_reserve(onid=32272, tsid=32272, sid=30720, eid=20202, priority=4, startMargine=30)

# 予約一覧確認
get_reserves()

# 予約を一時的に無効化（予約は残る）
set_reserve_enabled(id=2466, enabled=False)

# 予約を再度有効化
set_reserve_enabled(id=2466, enabled=True)

# 予約削除（取り消し不可）
delete_reserve(id=2466)

# 番組検索（空白区切りでAND、除外キーワード付き）
search_events(keyword="ドラマ 刑事", notKeyword="再放送", brief=True)

# 録画に失敗した番組・ドロップがある番組
get_rec_info(only="problem")
```

`add_reserve` で録画設定を省略すると、EpgTimerの予約設定プリセット「デフォルト」の初期値（指定サービス・優先度2・番組追従あり・ぴったり録画なし。マージン・録画後動作・録画フォルダはEDCBの既定の設定）で予約します。プリセットはEDCBの `EpgTimerSrv.ini` にあり、TCP接続では読めないため、EpgTimer側でプリセット「デフォルト」を変更していても反映されません。

一覧を返すツール（`get_epg`・`search_events`・`get_reserves`・`get_rec_info`）は、`limit` を超える分を省略します。続きがある場合は先頭に「1036件中1〜20件目を表示（残り1016件。続きはoffset=20で取得できます）」のように表示するので、`offset` を指定して続きを取得できます。

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `EDCB_HOST` | `localhost` | EDCB（EpgTimerSrv）を動かしているマシンのホスト名またはIPアドレス |
| `EDCB_PORT` | `4510` | EDCBのTCP接続のポート（EpgTimerSrvの設定`TCPPort`） |
| `EDCB_URL` | なし | 以前のHTTP接続用の設定。`EDCB_HOST` がなければ、このURLのホストに接続します（ポートは使いません） |
| `EDCB_CACHE_SEC` | `180` | チャンネル一覧をキャッシュする秒数（`0`でキャッシュしない） |
