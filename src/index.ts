import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EdcbClient, EventInfo, ReserveInfo } from './edcb-client.js';

const EDCB_URL = process.env.EDCB_URL ?? 'http://localhost:5510';
const EDCB_CACHE_SEC = Number(process.env.EDCB_CACHE_SEC ?? 180);

const client = new EdcbClient(EDCB_URL, Number.isFinite(EDCB_CACHE_SEC) ? EDCB_CACHE_SEC : 180);
const server = new McpServer({
  name: 'edcb-mcp',
  version: '1.0.0',
});

/** 地上デジタル放送かどうかをONIDで判定（ARIB規格: 0x7880以上が地上波割り当て） */
function isTerrestrial(onid: number): boolean {
  return onid >= 0x7880;
}

/** 検索用に正規化する（NFKCで全角英数字・半角カナ等を統一し、小文字化） */
function normalizeForSearch(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/** "YYYY-MM-DD HH:MM" または "YYYY-MM-DDTHH:MM" 形式をJSTとして解釈してDateを返す */
function parseJSTString(s: string): Date {
  const normalized = s.trim().replace(' ', 'T');
  if (/[+Z]/.test(normalized)) return new Date(normalized);
  return new Date(normalized + ':00+09:00');
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 開始と長さをJSTの "10/24(土) 09:00-11:54" 形式にする */
function formatSpan(start: Date, durationSec: number): string {
  const toJST = (d: Date) => new Date(d.getTime() + 9 * 3600 * 1000);
  const hm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const s = toJST(start);
  const e = toJST(new Date(start.getTime() + durationSec * 1000));
  return `${s.getUTCMonth() + 1}/${s.getUTCDate()}(${WEEKDAYS[s.getUTCDay()]}) ${hm(s)}-${hm(e)}`;
}

/** 改行や連続した空白を詰めて、先頭maxLen文字にする */
function summarize(text: string, maxLen: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > maxLen ? `${t.substring(0, maxLen)}…` : t;
}

/** 番組の出力。briefなら1行（日時・チャンネル・タイトル）、そうでなければジャンル・概要付き */
function formatEvent(e: EventInfo, opts: { brief: boolean; showService: boolean }): string {
  const id = `[${e.onid}-${e.tsid}-${e.sid}-${e.eid}]`;
  if (opts.brief) {
    return `${id} ${formatSpan(e.starttime, e.durationSec)} ${opts.showService ? `${e.service} ` : ''}${e.title}`;
  }
  const start = client.formatTime(e.starttime);
  const dur = client.formatDuration(e.durationSec);
  const genres = e.genre.map((g) => g.component_type_name).join(', ');
  const service = opts.showService ? `\n  チャンネル: ${e.service}` : '';
  return `${id} ${e.title}${service}\n  開始: ${start} (${dur})\n  ジャンル: ${genres || 'なし'}\n  概要: ${summarize(e.text, 80)}`;
}

/** 件数の表示。limitで切り詰めた場合は全体の件数も示す */
function countLabel(total: number, shown: number): string {
  return total > shown ? `${total}件中${shown}件を表示` : `${total}件`;
}

// ---- サーバー接続確認 ----
server.registerTool('ping', {
  description: 'EDCBサーバーへの接続確認。認識済みチャンネル数を返します。他のツールが失敗するときにまず実行してください',
  inputSchema: {},
}, async () => {
  const services = await client.getServices();
  return {
    content: [{ type: 'text', text: `EDCBサーバーに接続成功。チャンネル数: ${services.length}` }],
  };
});

// ---- ARIBジャンルテーブル ----
const ARIB_GENRES: Array<{ major: string; minor: string[] }> = [
  { major: 'ニュース／報道', minor: ['定時・総合', '天気', '特集・ドキュメント', '政治・国会', '経済・市況', '海外・国際', '解説', '討論・会談', '報道特番', 'ローカル・地域', '交通'] },
  { major: 'スポーツ', minor: ['スポーツニュース', '野球', 'サッカー', 'ゴルフ', 'その他の球技', '相撲・格闘技', 'オリンピック・国際大会', 'マラソン・陸上・水泳', 'モータースポーツ', 'マリン・ウィンタースポーツ', '競馬・公営競技'] },
  { major: '情報／ワイドショー', minor: ['芸能・ワイドショー', 'ファッション', '暮らし・住まい', '健康・医療', 'ショッピング・通販', 'グルメ・料理', 'イベント', '番組紹介・お知らせ'] },
  { major: 'ドラマ', minor: ['国内ドラマ', '海外ドラマ', '時代劇'] },
  { major: '音楽', minor: ['国内ロック・ポップス', '海外ロック・ポップス', 'クラシック・オペラ', 'ジャズ・フュージョン', '歌謡曲・演歌', 'ライブ・コンサート', 'ランキング・リクエスト', 'カラオケ・のど自慢', '民謡・邦楽', '童謡・キッズ', '民族音楽・ワールドミュージック'] },
  { major: 'バラエティ', minor: ['クイズ', 'ゲーム', 'トークバラエティ', 'お笑い・コメディ', '音楽バラエティ', '旅バラエティ', '料理バラエティ'] },
  { major: '映画', minor: ['洋画', '邦画', 'アニメ'] },
  { major: 'アニメ／特撮', minor: ['国内アニメ', '海外アニメ', '特撮'] },
  { major: 'ドキュメンタリー／教養', minor: ['社会・時事', '歴史・紀行', '自然・動物・環境', '宇宙・科学・医学', 'カルチャー・伝統文化', '文学・文芸', 'スポーツ', 'ドキュメンタリー全般', 'インタビュー・討論'] },
  { major: '劇場／公演', minor: ['現代劇・新劇', 'ミュージカル', 'ダンス・バレエ', '落語・演芸', '歌舞伎・古典'] },
  { major: '趣味／教育', minor: ['旅・釣り・アウトドア', '園芸・ペット・手芸', '音楽・美術・工芸', '囲碁・将棋', '麻雀・パチンコ', '車・オートバイ', 'コンピュータ・ＴＶゲーム', '会話・語学', '幼児・小学生', '中学生・高校生', '大学生・受験', '生涯教育・資格', '教育問題'] },
  { major: '福祉', minor: ['高齢者', '障害者', '社会福祉', 'ボランティア', '手話', '文字（字幕）', '音声解説'] },
];

// ---- ジャンル一覧 ----
server.registerTool('list_genres', {
  description: 'EPG番組検索で使えるジャンル名の一覧を返します。search_eventsのgenreNameパラメータに渡す値を確認するために使います。大カテゴリ（ニュース／報道、スポーツ…）と小カテゴリ（野球、サッカー…）の階層構造で表示します。genreNameは部分一致なので大カテゴリ名でも小カテゴリ名でも使えます',
  inputSchema: {},
}, async () => {
  const lines = ARIB_GENRES.flatMap((g) => [
    `【${g.major}】`,
    ...g.minor.map((m) => `  - ${m}`),
  ]);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
});

// ---- チャンネル一覧 ----
server.registerTool('get_services', {
  description: 'EDCBが認識しているチャンネル（サービス）一覧を取得します。get_epg・search_events・add_reserveで必要なonid/tsid/sidはここで確認します。出力形式: "[リモコン番号ch] サービス名 (onid-tsid-sid) - ネットワーク種別(実際のnetwork_name)"。networkは部分一致でフィルタします。"地上波"または"地上"でONIDベースの地上デジタル全局を取得できます（地域名ごとに異なるnetwork_nameを持つ局もまとめて表示）。フィルタが0件の場合は利用可能なネットワーク名一覧を返します',
  inputSchema: {
    network: z.string().optional().describe('ネットワーク名でフィルタ。"地上波"または"地上"で全地上デジタル局、"BS"でBS、"CS"でCS。実際のnetwork_nameによる部分一致も可'),
  },
}, async ({ network }) => {
  const services = await client.getServices();
  const isTerrestrialQuery = network && (network.includes('地上') || network === '地デジ');
  const filtered = network
    ? services.filter((s) =>
        isTerrestrialQuery
          ? isTerrestrial(s.onid) || s.network_name.includes(network) || s.service_name.includes(network)
          : s.network_name.includes(network) || s.service_name.includes(network)
      )
    : services;
  if (network && filtered.length === 0) {
    const networkNames = [...new Set(services.map((s) => s.network_name))].join('、');
    return {
      content: [{ type: 'text', text: `"${network}" に一致するチャンネルがありません。利用可能なネットワーク名: ${networkNames || '（チャンネル情報なし）'}` }],
    };
  }
  const text = filtered
    .map((s) => {
      const networkType = isTerrestrial(s.onid) ? `地上波(${s.network_name})` : s.network_name;
      const oneSeg = s.partialReceptionFlag ? ' [ワンセグ]' : '';
      return `[${s.remote_control_key_id}ch] ${s.service_name} (${s.onid}-${s.tsid}-${s.sid}) - ${networkType}${oneSeg}`;
    })
    .join('\n');
  return {
    content: [{ type: 'text', text: text || 'チャンネル情報がありません' }],
  };
});

// ---- 予約の表示 ----
const OVERLAP_MODES = ['重複なし', '重複あり（一部のみ録画）', '録画しない（チューナー不足）'];
const REC_MODES = ['全サービス', '指定サービス', '全サービス（デコードなし）', '指定サービス（デコードなし）', '視聴'];
/** eid=0xFFFFはプログラム予約（番組に紐付かない） */
const PROGRAM_RESERVE_EID = 0xffff;

/** 予約対象の番組がEPGから消えている予約のIDを返す（EPGを取得できなかったサービスは判定しない） */
async function findReservesMissingFromEpg(reserves: ReserveInfo[]): Promise<Set<number>> {
  const serviceKeys = [...new Set(reserves.map((r) => `${r.onid}-${r.tsid}-${r.sid}`))];
  const epgEids = new Map<string, Set<number>>();
  await Promise.all(
    serviceKeys.map(async (key) => {
      const [onid, tsid, sid] = key.split('-').map(Number);
      const events = await client.getEventsForService(onid, tsid, sid, 1).catch(() => null);
      if (events) epgEids.set(key, new Set(events.map((e) => e.eid)));
    })
  );
  return new Set(
    reserves
      .filter((r) => {
        const eids = epgEids.get(`${r.onid}-${r.tsid}-${r.sid}`);
        return r.eid !== PROGRAM_RESERVE_EID && eids !== undefined && !eids.has(r.eid);
      })
      .map((r) => r.id)
  );
}

function formatMargin(r: ReserveInfo): string {
  const rs = r.recSetting;
  return rs.useMargineFlag ? `開始${rs.startMargine}秒前/終了${rs.endMargine}秒後` : '既定';
}

/** 1件1行の予約表示。通常と違う項目（重複・無効・録画モード・優先度・マージン・EPG警告）だけを末尾に付ける */
function formatReserveLine(r: ReserveInfo, missingFromEpg: boolean): string {
  const rs = r.recSetting;
  const notes: string[] = [];
  if (r.overlapMode !== 0) notes.push(`⚠${OVERLAP_MODES[r.overlapMode] ?? `重複状態${r.overlapMode}`}`);
  if (missingFromEpg) notes.push('⚠EPGに番組なし（番組差し替えの可能性）');
  if (!rs.recEnabled) notes.push('無効');
  if (rs.recMode !== 1 && REC_MODES[rs.recMode]) notes.push(`録画モード:${REC_MODES[rs.recMode]}`);
  if (rs.priority !== 2) notes.push(`優先度${rs.priority}`);
  if (rs.useMargineFlag) notes.push(`マージン:${formatMargin(r)}`);
  if (r.eid === PROGRAM_RESERVE_EID) notes.push('プログラム予約');
  const eventId = `${r.onid}-${r.tsid}-${r.sid}-${r.eid}`;
  return `[ID:${r.id}] ${formatSpan(r.starttime, r.durationSec)} ${r.service} ${r.title} (${eventId})${notes.length ? ` ／ ${notes.join(' ／ ')}` : ''}`;
}

/** 1件の予約の詳細表示 */
function formatReserveDetail(r: ReserveInfo, missingFromEpg: boolean): string {
  const rs = r.recSetting;
  const folders = rs.recFolderList.map((f) => f.recFolder).filter(Boolean);
  const lines = [
    `[ID:${r.id}] ${r.title}`,
    `チャンネル: ${r.service}`,
    `日時: ${formatSpan(r.starttime, r.durationSec)} (${client.formatDuration(r.durationSec)})`,
    `番組ID: ${r.onid}-${r.tsid}-${r.sid}-${r.eid}${r.eid === PROGRAM_RESERVE_EID ? '（プログラム予約）' : ''}`,
    `重複状態: ${OVERLAP_MODES[r.overlapMode] ?? r.overlapMode}`,
    `録画: ${rs.recEnabled ? '有効' : '無効'}  録画モード: ${REC_MODES[rs.recMode] ?? rs.recMode}  優先度: ${rs.priority}`,
    `マージン: ${formatMargin(r)}  番組追従: ${rs.tuijyuuFlag ? 'する' : 'しない'}  ぴったり録画: ${rs.pittariFlag ? 'する' : 'しない'}`,
    `録画フォルダ: ${folders.length ? folders.join(', ') : '既定'}`,
  ];
  if (r.comment) lines.push(`コメント: ${r.comment}`);
  if (missingFromEpg) lines.push('⚠ EPGに番組なし（番組差し替えの可能性。同じ時間帯の番組をget_epgで確認してください）');
  return lines.join('\n');
}

const RESERVE_LINE_LEGEND = '※表示のない項目は通常どおり: 重複なし・有効・録画モード=指定サービス・優先度2・マージン既定';

// ---- 予約一覧 ----
server.registerTool('get_reserves', {
  description: [
    '現在の録画予約一覧を取得します。delete_reserve・change_reserve・set_reserve_enabledで使う予約IDはここで確認します。',
    '1件1行で "[ID:予約ID] 日時 チャンネル タイトル (onid-tsid-sid-eid)" の形式で表示し、通常と違う項目（重複・無効・録画モード・優先度・マージン）だけを末尾に付けます。',
    '"録画しない"はチューナー不足による重複、"無効"はset_reserve_enabledで無効化された予約です。',
    '"EPGに番組なし"の警告は、番組差し替え等で予約対象の番組がEPGから消えていることを示します（同じ時間帯の番組をget_epgで確認してください）。',
    'idを指定すると、その予約の詳細（録画フォルダ・番組追従等）を表示します。',
    '期間（from/to）・チャンネル（onid/tsid/sid、一部だけの指定も可）・タイトルのキーワード・状態（only）で絞り込めます。先頭に全予約の重複・警告の件数を表示するので、問題の有無だけならonly="problem"で確認できます。',
  ].join(' '),
  inputSchema: {
    id: z.number().optional().describe('詳細を表示する予約ID'),
    from: z.string().optional().describe('この日時に録画中、またはこれ以降に始まる予約に絞り込む（JST、形式: "YYYY-MM-DD HH:MM"）'),
    to: z.string().optional().describe('この日時までに始まる予約に絞り込む（JST、形式: "YYYY-MM-DD HH:MM"）'),
    onid: z.number().optional().describe('チャンネルで絞り込む場合のネットワークID'),
    tsid: z.number().optional().describe('チャンネルで絞り込む場合のTSID'),
    sid: z.number().optional().describe('チャンネルで絞り込む場合のサービスID'),
    keyword: z.string().optional().describe('タイトルに含まれるキーワード（部分一致、全角半角を区別しない）'),
    only: z
      .enum(['overlap', 'missing', 'disabled', 'problem'])
      .optional()
      .describe('状態で絞り込む。overlap=重複あり・録画しない、missing=EPGに番組なし、disabled=無効、problem=これらのいずれか'),
    limit: z.number().optional().describe('最大件数（デフォルト50）'),
  },
}, async ({ id, from, to, onid, tsid, sid, keyword, only, limit = 50 }) => {
  const reserves = await client.getReserves();
  if (id !== undefined) {
    const r = reserves.find((x) => x.id === id);
    if (!r) return { content: [{ type: 'text', text: `予約ID ${id} が見つかりません` }] };
    const missing = await findReservesMissingFromEpg([r]);
    return { content: [{ type: 'text', text: formatReserveDetail(r, missing.has(r.id)) }] };
  }
  if (reserves.length === 0) {
    return { content: [{ type: 'text', text: '予約がありません' }] };
  }
  const fromTime = from ? parseJSTString(from) : undefined;
  const toTime = to ? parseJSTString(to) : undefined;
  if ((fromTime && isNaN(fromTime.getTime())) || (toTime && isNaN(toTime.getTime()))) {
    return { content: [{ type: 'text', text: 'from/toは "YYYY-MM-DD HH:MM" 形式（JST）で指定してください' }] };
  }

  const missing = await findReservesMissingFromEpg(reserves);
  const isOverlap = (r: ReserveInfo) => r.overlapMode !== 0;
  const isDisabled = (r: ReserveInfo) => !r.recSetting.recEnabled;
  const statusFilters = {
    overlap: isOverlap,
    missing: (r: ReserveInfo) => missing.has(r.id),
    disabled: isDisabled,
    problem: (r: ReserveInfo) => isOverlap(r) || missing.has(r.id) || isDisabled(r),
  };
  const kw = keyword ? normalizeForSearch(keyword) : undefined;
  const matched = reserves
    .filter(
      (r) =>
        (!fromTime || r.starttime.getTime() + r.durationSec * 1000 > fromTime.getTime()) &&
        (!toTime || r.starttime <= toTime) &&
        (onid === undefined || r.onid === onid) &&
        (tsid === undefined || r.tsid === tsid) &&
        (sid === undefined || r.sid === sid) &&
        (!kw || normalizeForSearch(r.title).includes(kw)) &&
        (!only || statusFilters[only](r))
    )
    .sort((a, b) => a.starttime.getTime() - b.starttime.getTime());

  const count = (pred: (r: ReserveInfo) => boolean) => reserves.filter(pred).length;
  const summary =
    `予約数: ${reserves.length}件（重複あり ${count((r) => r.overlapMode === 1)}件・` +
    `録画しない ${count((r) => r.overlapMode === 2)}件・無効 ${count(isDisabled)}件・EPGに番組なし ${missing.size}件）`;
  const filtered = from || to || onid !== undefined || tsid !== undefined || sid !== undefined || keyword || only;
  if (filtered && matched.length === 0) {
    return { content: [{ type: 'text', text: `${summary}\n条件に一致する予約はありません` }] };
  }
  const shown = matched.slice(0, limit);
  const text = shown.map((r) => formatReserveLine(r, missing.has(r.id))).join('\n');
  const header = [summary];
  if (filtered) header.push(`条件に一致: ${countLabel(matched.length, shown.length)}`);
  else if (matched.length > shown.length) header.push(`${countLabel(matched.length, shown.length)}（from/to・チャンネル・keyword・onlyで絞り込めます）`);
  header.push(RESERVE_LINE_LEGEND);
  return {
    content: [{ type: 'text', text: `${header.join('\n')}\n\n${text}` }],
  };
});

// ---- 番組EPG取得（特定チャンネル）----
server.registerTool('get_epg', {
  description: '特定チャンネルの番組表（EPG）を取得します。onid/tsid/sidはget_servicesで確認してください。add_reserveに必要なeidはここで確認します。from/toで日時範囲を指定でき、省略時は現在放送中の番組から表示します。結果は "[onid-tsid-sid-eid] タイトル" の形式で表示されます',
  inputSchema: {
    onid: z.number().describe('ネットワークID（get_servicesで確認）'),
    tsid: z.number().describe('トランスポートストリームID（get_servicesで確認）'),
    sid: z.number().describe('サービスID（get_servicesで確認）'),
    from: z.string().optional().describe('この日時に放送中、またはこれ以降に始まる番組から表示（JST、形式: "YYYY-MM-DD HH:MM"、省略時は現在時刻）'),
    to: z.string().optional().describe('この日時までに始まる番組まで表示（JST、形式: "YYYY-MM-DD HH:MM"）'),
    brief: z.boolean().optional().describe('trueで1件1行（日時・タイトルのみ）の簡易表示'),
    limit: z.number().optional().describe('最大件数（デフォルト30）'),
  },
}, async ({ onid, tsid, sid, from, to, brief = false, limit = 30 }) => {
  const events = await client.getEventsForService(onid, tsid, sid, 1);
  if (events.length === 0) {
    return { content: [{ type: 'text', text: '番組情報がありません' }] };
  }
  const fromTime = from ? parseJSTString(from) : new Date();
  const toTime = to ? parseJSTString(to) : undefined;
  if (isNaN(fromTime.getTime()) || (toTime && isNaN(toTime.getTime()))) {
    return { content: [{ type: 'text', text: 'from/toは "YYYY-MM-DD HH:MM" 形式（JST）で指定してください' }] };
  }
  const inRange = events
    .filter((e) => {
      const end = new Date(e.starttime.getTime() + e.durationSec * 1000);
      return end > fromTime && (!toTime || e.starttime <= toTime);
    })
    .sort((a, b) => a.starttime.getTime() - b.starttime.getTime());
  if (inRange.length === 0) {
    return { content: [{ type: 'text', text: '指定された範囲の番組情報がありません' }] };
  }
  const upcoming = inRange.slice(0, limit);

  const text = upcoming
    .map((e) => formatEvent(e, { brief, showService: false }))
    .join(brief ? '\n' : '\n\n');

  return {
    content: [{ type: 'text', text: `${upcoming[0].service}の番組: ${countLabel(inRange.length, upcoming.length)}\n\n${text}` }],
  };
});

// ---- 番組詳細取得 ----
server.registerTool('get_event_info', {
  description: '番組の詳細情報（フル説明文・ジャンル・無料/有料フラグ等）を取得します。onid/tsid/sid/eidはget_epgまたはsearch_eventsの結果から取得してください。予約前に内容を確認するときに使います',
  inputSchema: {
    onid: z.number().describe('ネットワークID'),
    tsid: z.number().describe('トランスポートストリームID'),
    sid: z.number().describe('サービスID'),
    eid: z.number().describe('イベントID'),
  },
}, async ({ onid, tsid, sid, eid }) => {
  const ev = await client.getEventInfo(onid, tsid, sid, eid);
  if (!ev) {
    return { content: [{ type: 'text', text: '番組情報が見つかりませんでした' }] };
  }
  const start = client.formatTime(ev.starttime);
  const end = client.formatTime(new Date(ev.starttime.getTime() + ev.durationSec * 1000));
  const dur = client.formatDuration(ev.durationSec);
  const genres = ev.genre.map((g) => g.component_type_name).join(', ');
  const text = `タイトル: ${ev.title}
チャンネル: ${ev.service}
開始: ${start}
終了: ${end}
時間: ${dur}
ジャンル: ${genres || 'なし'}
無料放送: ${ev.freeCAFlag ? 'いいえ' : 'はい'}
番組ID: ${ev.onid}-${ev.tsid}-${ev.sid}-${ev.eid}

【番組説明】
${ev.text}`;
  return { content: [{ type: 'text', text: text }] };
});

// ---- 番組検索 ----
server.registerTool('search_events', {
  description: [
    '番組を検索・絞り込みします。keyword・genreName・番組長・開始時刻のいずれか1つ以上を指定してください。複数指定した場合はAND条件です。',
    '全サービスのEPGをクライアント側でフィルタします（番組表は数分間キャッシュされるため、2回目以降の検索は高速です）。',
    'onid/tsid/sidは一部だけの指定も可能で、指定した値に一致するチャンネルに絞り込みます（例: onidのみでそのネットワーク全体）。',
    'ワンセグ（部分受信）サービスは通常の放送と番組が重複するため、sidを指定しない限りデフォルトで除外します。含める場合はincludeOneSeg=trueを指定してください。',
    'ジャンル名はlist_genresツールで確認できます。大カテゴリ（例: "ドラマ"）でも小カテゴリ（例: "国内ドラマ"）でも部分一致で使えます。大カテゴリは検索範囲が広くなり、小カテゴリは絞り込みが強くなります。',
    '開始時刻は日本時間(JST)で "YYYY-MM-DD HH:MM" 形式で指定します。',
    '出力形式: "[onid-tsid-sid-eid] タイトル"。onid=オリジナルネットワークID、tsid=トランスポートストリームID、sid=サービスID、eid=イベントID(番組固有ID)。番組識別にはこの4つの値が必要です。',
  ].join(' '),
  inputSchema: {
    keyword: z.string().optional().describe('タイトルまたは番組説明に含まれるキーワード（部分一致）'),
    genreName: z.string().optional().describe('ジャンル名の部分一致。使えるジャンル名はlist_genresで確認してください。大カテゴリ（例: "ドラマ"）は広く、小カテゴリ（例: "国内ドラマ"）は絞り込みが強くなります'),
    durationMin: z.number().optional().describe('番組長の最小値（分）。例: 映画を探す場合は 60 など'),
    durationMax: z.number().optional().describe('番組長の最大値（分）。例: ショート番組を探す場合は 30 など'),
    startAfter: z.string().optional().describe('この日時以降に開始する番組を絞り込む（JST、形式: "YYYY-MM-DD HH:MM"、例: "2026-03-25 19:00"）'),
    startBefore: z.string().optional().describe('この日時以前に開始する番組を絞り込む（JST、形式: "YYYY-MM-DD HH:MM"、例: "2026-03-25 23:59"）'),
    onid: z.number().optional().describe('チャンネルを絞り込む場合のネットワークID（get_servicesで確認）'),
    tsid: z.number().optional().describe('チャンネルを絞り込む場合のTSID（get_servicesで確認）'),
    sid: z.number().optional().describe('チャンネルを絞り込む場合のサービスID（get_servicesで確認）'),
    includeOneSeg: z.boolean().optional().describe('ワンセグ（部分受信）サービスも検索対象に含める（デフォルトfalse。sid指定時は常に含める）'),
    brief: z.boolean().optional().describe('trueで1件1行（日時・チャンネル・タイトルのみ）の簡易表示。多くの候補から絞り込むときに使います'),
    limit: z.number().optional().describe('最大件数（デフォルト20）'),
  },
}, async ({ keyword, genreName, durationMin, durationMax, startAfter, startBefore, onid, tsid, sid, includeOneSeg = false, brief = false, limit = 20 }) => {
  if (!keyword && !genreName && durationMin === undefined && durationMax === undefined && !startAfter && !startBefore) {
    return { content: [{ type: 'text', text: 'keyword、genreName、durationMin/durationMax、startAfter/startBefore のいずれかを指定してください' }] };
  }

  let services: Array<{ onid: number; tsid: number; sid: number }>;
  if (onid !== undefined && tsid !== undefined && sid !== undefined) {
    services = [{ onid, tsid, sid }];
  } else {
    services = (await client.getServices()).filter(
      (s) =>
        (onid === undefined || s.onid === onid) &&
        (tsid === undefined || s.tsid === tsid) &&
        (sid === undefined || s.sid === sid) &&
        (includeOneSeg || sid !== undefined || !s.partialReceptionFlag)
    );
    if (services.length === 0) {
      const spec = [`onid=${onid ?? '*'}`, `tsid=${tsid ?? '*'}`, `sid=${sid ?? '*'}`].join(', ');
      return { content: [{ type: 'text', text: `指定されたチャンネル（${spec}）が見つかりません。get_servicesで確認してください` }] };
    }
  }

  const allEvents = (
    await Promise.all(
      services.map((s) => client.getEventsForService(s.onid, s.tsid, s.sid, 1).catch(() => []))
    )
  ).flat();

  let results = allEvents;

  if (keyword) {
    const kw = normalizeForSearch(keyword);
    results = results.filter((e) => normalizeForSearch(e.title).includes(kw) || normalizeForSearch(e.text).includes(kw));
  }

  if (genreName) {
    const gn = normalizeForSearch(genreName);
    results = results.filter((e) => e.genre.some((g) => normalizeForSearch(g.component_type_name).includes(gn)));
  }

  if (durationMin !== undefined) {
    results = results.filter((e) => e.durationSec >= durationMin * 60);
  }

  if (durationMax !== undefined) {
    results = results.filter((e) => e.durationSec <= durationMax * 60);
  }

  if (startAfter) {
    const after = parseJSTString(startAfter);
    results = results.filter((e) => e.starttime >= after);
  }

  if (startBefore) {
    const before = parseJSTString(startBefore);
    results = results.filter((e) => e.starttime <= before);
  }

  if (results.length === 0) {
    return { content: [{ type: 'text', text: '条件に一致する番組が見つかりませんでした' }] };
  }
  const shown = results.sort((a, b) => a.starttime.getTime() - b.starttime.getTime()).slice(0, limit);
  const text = shown
    .map((e) => formatEvent(e, { brief, showService: true }))
    .join(brief ? '\n' : '\n\n');
  return {
    content: [{ type: 'text', text: `条件に一致する番組: ${countLabel(results.length, shown.length)}\n\n${text}` }],
  };
});

// ---- 予約追加 ----
server.registerTool('add_reserve', {
  description: '番組の録画予約を追加します。EDCBのデフォルトプリセット設定で予約されます。onid/tsid/sid/eidはget_epgまたはsearch_eventsの結果 "[onid-tsid-sid-eid]" から取得してください。予約後はget_reservesで確認できます',
  inputSchema: {
    onid: z.number().describe('ネットワークID'),
    tsid: z.number().describe('トランスポートストリームID'),
    sid: z.number().describe('サービスID'),
    eid: z.number().describe('イベントID'),
  },
}, async ({ onid, tsid, sid, eid }) => {
  const reserveId = await client.addReserve(onid, tsid, sid, eid);
  return {
    content: [
      {
        type: 'text',
        text: `予約を追加しました（予約ID: ${reserveId}、番組: ${onid}-${tsid}-${sid}-${eid}）`,
      },
    ],
  };
});

// ---- 予約削除 ----
server.registerTool('delete_reserve', {
  description: '録画予約を削除します。削除は取り消せません。予約IDはget_reservesの "[ID:xxx]" から取得してください',
  inputSchema: {
    id: z.number().describe('削除する予約のID'),
  },
  annotations: { destructiveHint: true },
}, async ({ id }) => {
  await client.deleteReserve(id);
  return {
    content: [{ type: 'text', text: `予約ID ${id} を削除しました` }],
  };
});

// ---- 予約有効/無効切り替え ----
server.registerTool('set_reserve_enabled', {
  description: '録画予約の有効・無効を切り替えます。無効にしても予約は残るため、後から再度有効化できます。delete_reserveと異なり取り消し可能な安全な操作です。予約IDはget_reservesの "[ID:xxx]" から取得してください',
  inputSchema: {
    id: z.number().describe('対象の予約ID'),
    enabled: z.boolean().describe('true=有効（録画する）、false=無効（録画しない）'),
  },
}, async ({ id, enabled }) => {
  await client.setReserveEnabled(id, enabled);
  const state = enabled ? '有効' : '無効';
  return {
    content: [{ type: 'text', text: `予約ID ${id} を${state}にしました` }],
  };
});

// ---- 予約設定変更 ----
server.registerTool('change_reserve', {
  description: '既存の録画予約の設定（優先度・録画モード・マージン等）を変更します。予約IDはget_reservesで確認してください。変更しないパラメータは省略可能です',
  inputSchema: {
    id: z.number().describe('変更する予約のID'),
    priority: z.number().min(1).max(5).optional().describe('優先度（1-5）'),
    recMode: z.number().min(0).max(4).optional().describe('録画モード（0=全サービス, 1=指定サービス, 2=全サービスデコードなし, 3=指定サービスデコードなし, 4=視聴）'),
    tuijyuuFlag: z.boolean().optional().describe('番組追従（true/false）'),
    pittariFlag: z.boolean().optional().describe('ぴったり録画（true/false）'),
    suspendMode: z.number().min(0).max(4).optional().describe('録画後動作（0=デフォルト, 1=スタンバイ, 2=休止, 3=シャットダウン, 4=何もしない）'),
    startMargine: z.number().optional().describe('開始マージン（秒）'),
    endMargine: z.number().optional().describe('終了マージン（秒）'),
  },
}, async ({ id, ...params }) => {
  await client.changeReserve(id, params);
  return {
    content: [{ type: 'text', text: `予約ID ${id} の設定を変更しました` }],
  };
});

// ---- 録画済み番組一覧 ----
server.registerTool('get_rec_info', {
  description: '録画済み番組の一覧を取得します。録画ファイルパス・ドロップ数・録画状態を確認できます。状態: 録画終了=正常, 録画中断=途中停止, 録画失敗=エラー',
  inputSchema: {
    id: z.number().optional().describe('特定の録画IDを指定（省略時は全件、最大200件）'),
  },
}, async ({ id }) => {
  const infos = await client.getRecInfo(id);
  if (infos.length === 0) {
    return { content: [{ type: 'text', text: '録画済み番組がありません' }] };
  }
  const recStatusLabels: Record<number, string> = {
    1: '録画終了',
    2: '録画中断',
    3: '録画失敗',
    9: '情報なし',
  };
  const text = infos
    .map((r) => {
      const start = client.formatTime(r.starttime);
      const dur = client.formatDuration(r.durationSec);
      const status = recStatusLabels[r.recStatus] ?? `状態${r.recStatus}`;
      const dropInfo = r.drops > 0 ? ` ドロップ:${r.drops}` : '';
      return `[ID:${r.id}] ${r.title}\n  チャンネル: ${r.service}\n  録画: ${start} (${dur}) ${status}${dropInfo}\n  ファイル: ${r.recFilePath}`;
    })
    .join('\n\n');
  return {
    content: [{ type: 'text', text: `録画済み番組数: ${infos.length}\n\n${text}` }],
  };
});

// ---- 自動予約一覧 ----
server.registerTool('get_auto_add', {
  description: 'EPGキーワード自動予約（録画予約の自動登録ルール）の一覧を取得します。キーワード・除外キーワード・対象チャンネル・これまでの追加件数を確認できます',
  inputSchema: {},
}, async () => {
  const infos = await client.getAutoAdd();
  if (infos.length === 0) {
    return { content: [{ type: 'text', text: '自動予約がありません' }] };
  }
  const text = infos
    .map((a) => {
      const services = a.serviceList
        .map((s) => `${s.onid}-${s.tsid}-${s.sid}`)
        .join(', ');
      return `[ID:${a.id}] キーワード: "${a.keyword}"\n  除外: ${a.notKeyword || 'なし'}\n  対象: ${services || '全チャンネル'}\n  追加済: ${a.addCount}件`;
    })
    .join('\n\n');
  return {
    content: [{ type: 'text', text: `自動予約数: ${infos.length}\n\n${text}` }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`EDCB MCP Server started (EDCB_URL: ${EDCB_URL})`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
