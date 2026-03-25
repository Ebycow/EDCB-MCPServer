# EDCB MCP Server

EDCBをLLMから操作するためのMCPサーバー。番組情報取得、予約管理などが可能です。

## 前提

- EDCBがWebUIとともに起動していること
- Material WebUIがインストールされていること（`/EMWUI/`パスが有効であること）
- デフォルト接続先: `http://localhost:5510`

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
        "EDCB_URL": "http://192.168.1.x:5510"
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
| `get_event_info` | 番組詳細取得 |
| `search_events` | キーワード番組検索 |
| `get_reserves` | 録画予約一覧取得 |
| `add_reserve` | 録画予約追加（デフォルトプリセット使用） |
| `delete_reserve` | 録画予約削除 |
| `change_reserve` | 録画予約設定変更 |
| `get_rec_info` | 録画済み番組一覧取得 |
| `get_auto_add` | 自動予約（EPGキーワード）一覧取得 |

## 使用例

```
# チャンネル一覧（地上波のみ）
get_services(network="地上波")

# NHK総合の番組表を取得
get_epg(onid=32272, tsid=32272, sid=30720)

# 番組を予約
add_reserve(onid=32272, tsid=32272, sid=30720, eid=20202)

# 予約一覧確認
get_reserves()

# 予約削除
delete_reserve(id=2466)
```

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `EDCB_URL` | `http://localhost:5510` | EDCBサーバーのURL |
