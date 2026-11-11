import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EdcbClient, EventInfo, RecInfo, ReserveInfo } from './edcb-client.js';
import { ARIB_GENRES } from './genres.js';

const EDCB_URL = process.env.EDCB_URL ?? 'http://localhost:5510';
const EDCB_TCP_PORT = Number(process.env.EDCB_TCP_PORT ?? 4510);
const EDCB_CACHE_SEC = Number(process.env.EDCB_CACHE_SEC ?? 180);

const client = new EdcbClient({
  url: EDCB_URL,
  tcpHost: process.env.EDCB_TCP_HOST,
  tcpPort: Number.isFinite(EDCB_TCP_PORT) ? EDCB_TCP_PORT : 4510,
  cacheTtlSec: Number.isFinite(EDCB_CACHE_SEC) ? EDCB_CACHE_SEC : 180,
});
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

/** JSTの曜日（"土" など） */
function weekdayJST(d: Date): string {
  return WEEKDAYS[new Date(d.getTime() + 9 * 3600 * 1000).getUTCDay()];
}

/** 開始と長さをJSTの "2026-10-24 09:00-11:54 (土)" 形式にする（開始部分はツールの日時入力と同じ形式） */
function formatSpan(start: Date, durationSec: number): string {
  const end = client.formatTime(new Date(start.getTime() + durationSec * 1000)).slice(-5);
  return `${client.formatTime(start)}-${end} (${weekdayJST(start)})`;
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
  const dur = client.formatDuration(e.durationSec);
  const genres = e.genre.map((g) => g.component_type_name).join(', ');
  const service = opts.showService ? `\n  チャンネル: ${e.service}` : '';
  return `${id} ${e.title}${service}\n  日時: ${formatSpan(e.starttime, e.durationSec)} ${dur}\n  ジャンル: ${genres || 'なし'}\n  概要: ${summarize(e.text, 80)}`;
}

/** 件数の表示。limitで切り詰めた場合は全体の件数も示す */
function countLabel(total: number, shown: number): string {
  return total > shown ? `${total}件中${shown}件を表示` : `${total}件`;
}

/**
 * チャンネルの番組表が取得できない理由を説明する。
 * EDCBは原因によらず「EPGデータを読み込み中、または存在しません」としか返さないため、チャンネル一覧と照らし合わせる
 */
async function explainServiceWithoutEpg(onid: number, tsid: number, sid: number): Promise<string> {
  const id = `${onid}-${tsid}-${sid}`;
  const service = (await client.getServices()).find((s) => s.onid === onid && s.tsid === tsid && s.sid === sid);
  if (!service) {
    return `チャンネル ${id} はEDCBのチャンネル一覧にありません。onid/tsid/sidをget_servicesで確認してください`;
  }
  return `チャンネル ${id}（${service.service_name}）の番組表がEDCBにありません。EPGをまだ取得していないか、番組情報を送っていないチャンネルの可能性があります`;
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

/** 予約対象の番組がEPGから消えている予約のIDを返す（番組表がないサービスは判定しない） */
async function findReservesMissingFromEpg(reserves: ReserveInfo[]): Promise<Set<number>> {
  const serviceKeys = [...new Set(reserves.map((r) => `${r.onid}-${r.tsid}-${r.sid}`))];
  const services = serviceKeys.map((key) => {
    const [onid, tsid, sid] = key.split('-').map(Number);
    return { onid, tsid, sid };
  });
  const epgEids = new Map<string, Set<number>>();
  for (const e of await client.getEvents(services)) {
    const key = `${e.onid}-${e.tsid}-${e.sid}`;
    if (!epgEids.has(key)) epgEids.set(key, new Set());
    epgEids.get(key)!.add(e.eid);
  }
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
    `日時: ${formatSpan(r.starttime, r.durationSec)} ${client.formatDuration(r.durationSec)}`,
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

/** 番組の長さの上限の目安（放送中の番組を開始時刻の範囲で探すときに、範囲をこの分だけ前に広げる） */
const LONGEST_EVENT_MS = 24 * 3600 * 1000;

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
  const fromTime = from ? parseJSTString(from) : new Date();
  const toTime = to ? parseJSTString(to) : undefined;
  if (isNaN(fromTime.getTime()) || (toTime && isNaN(toTime.getTime()))) {
    return { content: [{ type: 'text', text: 'from/toは "YYYY-MM-DD HH:MM" 形式（JST）で指定してください' }] };
  }
  // fromの時点で放送中の番組も含めるため、開始時刻の範囲は長時間番組の分だけ前に広げる
  const events = await client.getEventsForService(onid, tsid, sid, {
    from: new Date(fromTime.getTime() - LONGEST_EVENT_MS),
    to: toTime && new Date(toTime.getTime() + 1),
  });
  if (events.length === 0) {
    const all = await client.getEventsForService(onid, tsid, sid);
    if (all.length === 0) {
      return { content: [{ type: 'text', text: await explainServiceWithoutEpg(onid, tsid, sid) }] };
    }
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
  description: '番組の詳細情報（番組説明・出演者などの詳細情報・ジャンル・無料/有料フラグ等）を取得します。onid/tsid/sid/eidはget_epgまたはsearch_eventsの結果から取得してください。予約前に内容を確認するときに使います',
  inputSchema: {
    onid: z.number().describe('ネットワークID'),
    tsid: z.number().describe('トランスポートストリームID'),
    sid: z.number().describe('サービスID'),
    eid: z.number().describe('イベントID'),
  },
}, async ({ onid, tsid, sid, eid }) => {
  const ev = await client.getEventInfo(onid, tsid, sid, eid);
  if (!ev) {
    const serviceEvents = await client.getEventsForService(onid, tsid, sid);
    if (serviceEvents.length === 0) {
      return { content: [{ type: 'text', text: `番組ID ${onid}-${tsid}-${sid}-${eid} が見つかりません。${await explainServiceWithoutEpg(onid, tsid, sid)}` }] };
    }
    return {
      content: [{
        type: 'text',
        text: `番組ID ${onid}-${tsid}-${sid}-${eid} はこのチャンネル（${serviceEvents[0].service}）の番組表にありません。番組の差し替えで削除されたか、放送が終わった可能性があります。同じ時間帯の番組はget_epgのfrom/toで確認してください`,
      }],
    };
  }
  const start = client.formatTime(ev.starttime);
  const end = client.formatTime(new Date(ev.starttime.getTime() + ev.durationSec * 1000));
  const dur = client.formatDuration(ev.durationSec);
  const genres = ev.genre.map((g) => g.component_type_name).join(', ');
  const text = `タイトル: ${ev.title}
チャンネル: ${ev.service}
開始: ${start} (${weekdayJST(ev.starttime)})
終了: ${end}
時間: ${dur}
ジャンル: ${genres || 'なし'}
無料放送: ${ev.freeCAFlag ? 'いいえ' : 'はい'}
番組ID: ${ev.onid}-${ev.tsid}-${ev.sid}-${ev.eid}

【番組説明】
${ev.text}`;
  const extText = ev.extText.replace(/\r\n?/g, '\n').trim();
  return { content: [{ type: 'text', text: extText ? `${text}\n\n【詳細情報】\n${extText}` : text }] };
});

// ---- 番組検索 ----
server.registerTool('search_events', {
  description: [
    '番組を検索・絞り込みします。keyword・genreName・番組長・開始時刻のいずれか1つ以上を指定してください。複数指定した場合はAND条件です。',
    'keywordはEDCBの番組検索機能で探します（空白区切りでAND検索、全角半角・大文字小文字は区別しない）。titleOnly=trueでタイトルだけを検索します。',
    'onid/tsid/sidは一部だけの指定も可能で、指定した値に一致するチャンネルに絞り込みます（例: onidのみでそのネットワーク全体）。',
    'ワンセグ（部分受信）サービスは通常の放送と番組が重複するため、sidを指定しない限りデフォルトで除外します。含める場合はincludeOneSeg=trueを指定してください。',
    'ジャンル名はlist_genresツールで確認できます。大カテゴリ（例: "ドラマ"）でも小カテゴリ（例: "国内ドラマ"）でも部分一致で使えます。大カテゴリは検索範囲が広くなり、小カテゴリは絞り込みが強くなります。',
    '開始時刻は日本時間(JST)で "YYYY-MM-DD HH:MM" 形式で指定します。',
    '出力形式: "[onid-tsid-sid-eid] タイトル"。onid=オリジナルネットワークID、tsid=トランスポートストリームID、sid=サービスID、eid=イベントID(番組固有ID)。番組識別にはこの4つの値が必要です。',
  ].join(' '),
  inputSchema: {
    keyword: z.string().optional().describe('タイトル・番組説明・詳細情報に含まれるキーワード（部分一致）。空白で区切るとAND検索（例: "ドラマ 刑事"）'),
    notKeyword: z.string().optional().describe('除外キーワード。keywordと一緒に指定し、これを含む番組を除く。空白で区切るとどれか1つでも含む番組を除く（例: "再放送 ダイジェスト"）'),
    titleOnly: z.boolean().optional().describe('trueでkeywordをタイトルだけから探す（デフォルトfalse）。番組説明の出演者名などによる関係のないヒットを減らせます'),
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
}, async ({ keyword, notKeyword, titleOnly = false, genreName, durationMin, durationMax, startAfter, startBefore, onid, tsid, sid, includeOneSeg = false, brief = false, limit = 20 }) => {
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

  const after = startAfter ? parseJSTString(startAfter) : undefined;
  const before = startBefore ? parseJSTString(startBefore) : undefined;
  if ((after && isNaN(after.getTime())) || (before && isNaN(before.getTime()))) {
    return { content: [{ type: 'text', text: 'startAfter/startBeforeは "YYYY-MM-DD HH:MM" 形式（JST）で指定してください' }] };
  }

  // キーワードはEDCBの番組検索で探す（開始時刻の範囲は指定できないため、あとで絞り込む）。
  // キーワードがなければ、開始時刻の範囲で番組表をまとめて取得する
  let results = keyword?.trim()
    ? await client.searchEvents(keyword, services, { notKeyword, titleOnly })
    : await client.getEvents(services, { from: after, to: before && new Date(before.getTime() + 1) });

  if (after) {
    results = results.filter((e) => e.starttime >= after);
  }

  if (before) {
    results = results.filter((e) => e.starttime <= before);
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
  description: '番組の録画予約を追加します。EDCBのデフォルトプリセット設定で予約されます。onid/tsid/sid/eidはget_epgまたはsearch_eventsの結果 "[onid-tsid-sid-eid]" から取得してください。結果には追加した予約の日時・重複状態と、同じ時間帯の予約の件数（チューナー不足になった予約があればその一覧）を表示するため、重複確認のためにget_reservesを呼び直す必要はありません',
  inputSchema: {
    onid: z.number().describe('ネットワークID'),
    tsid: z.number().describe('トランスポートストリームID'),
    sid: z.number().describe('サービスID'),
    eid: z.number().describe('イベントID'),
  },
}, async ({ onid, tsid, sid, eid }) => {
  const reserveId = await client.addReserve(onid, tsid, sid, eid);
  const reserves = await client.getReserves();
  // 古いAPIは予約IDを返さないことがあるため、番組IDでも探す
  const added =
    reserves.find((r) => reserveId !== 0 && r.id === reserveId) ??
    reserves.find((r) => r.onid === onid && r.tsid === tsid && r.sid === sid && r.eid === eid);
  if (!added) {
    return {
      content: [{ type: 'text', text: `予約を追加しました（予約ID: ${reserveId}、番組: ${onid}-${tsid}-${sid}-${eid}）。予約一覧から見つからなかったため、get_reservesで確認してください` }],
    };
  }

  const end = (r: ReserveInfo) => r.starttime.getTime() + r.durationSec * 1000;
  const sameTime = reserves
    .filter((r) => r.id !== added.id && r.starttime.getTime() < end(added) && end(r) > added.starttime.getTime())
    .sort((a, b) => a.starttime.getTime() - b.starttime.getTime());
  const conflicts = sameTime.filter((r) => r.overlapMode !== 0);

  const lines = ['予約を追加しました', formatReserveLine(added, false)];
  if (added.overlapMode !== 0) {
    lines.push('⚠ この予約はチューナーが足りず、録画されないか一部のみの録画になります。優先度の変更や他の予約の無効化を検討してください');
  }
  lines.push('', `同じ時間帯の他の予約: ${sameTime.length}件（うち重複あり・録画しない: ${conflicts.length}件）`);
  lines.push(...conflicts.map((r) => formatReserveLine(r, false)));
  return { content: [{ type: 'text', text: lines.join('\n') }] };
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
  description: '既存の録画予約の設定（優先度・録画モード・マージン等）を変更します。予約IDはget_reservesで確認してください。指定した項目だけを変更し、省略した項目と有効・無効の状態はそのまま残ります。マージンを片方だけ指定した場合、既定のマージンを使っていた予約のもう片方はEDCBの既定値になります',
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

/** 録画結果が正常終了（EDCBのREC_END_STATUS_NORMAL） */
const REC_END_STATUS_NORMAL = 1;

/** offset・limitで切り出した範囲の表示。続きがあれば、続きを取得するoffsetを示す */
function pageLabel(total: number, offset: number, shown: number): string {
  if (shown === 0) return `${total}件（offset=${offset}以降はありません）`;
  if (offset === 0 && shown === total) return `${total}件`;
  const rest = total - offset - shown;
  const range = `${total}件中${shown === 1 ? offset + 1 : `${offset + 1}〜${offset + shown}`}件目を表示`;
  return rest > 0 ? `${range}（残り${rest}件。続きはoffset=${offset + shown}で取得できます）` : range;
}

// ---- 録画済み番組一覧 ----
server.registerTool('get_rec_info', {
  description: [
    '録画済み番組の一覧を開始時刻の新しい順に取得します。録画ファイルパス・ドロップ数・スクランブル数・録画結果を確認できます。',
    '録画結果はEDCBの説明文（正常なら「録画終了」）で表示し、正常に終わらなかった録画には⚠を付けます。',
    '件数が多いため、一度に表示するのはlimit件（デフォルト50）までです。続きがある場合は先頭に「残りN件。続きはoffset=Xで取得できます」と表示するので、そのoffsetで再度呼び出してください。',
    'タイトルのキーワード・期間（from/to）・問題のある録画（only="problem"）で絞り込めます。',
  ].join(' '),
  inputSchema: {
    id: z.number().optional().describe('特定の録画IDを指定'),
    keyword: z.string().optional().describe('タイトルに含まれるキーワード（部分一致、全角半角を区別しない）'),
    from: z.string().optional().describe('この日時以降に開始した録画に絞り込む（JST、形式: "YYYY-MM-DD HH:MM"）'),
    to: z.string().optional().describe('この日時までに開始した録画に絞り込む（JST、形式: "YYYY-MM-DD HH:MM"）'),
    only: z
      .enum(['problem'])
      .optional()
      .describe('problem=正常に終わらなかった録画、またはドロップ・スクランブルがある録画だけにする'),
    offset: z.number().int().min(0).optional().describe('先頭から飛ばす件数（続きを取得するとき。デフォルト0）'),
    limit: z.number().int().min(1).optional().describe('最大件数（デフォルト50）'),
  },
}, async ({ id, keyword, from, to, only, offset = 0, limit = 50 }) => {
  const fromTime = from ? parseJSTString(from) : undefined;
  const toTime = to ? parseJSTString(to) : undefined;
  if ((fromTime && isNaN(fromTime.getTime())) || (toTime && isNaN(toTime.getTime()))) {
    return { content: [{ type: 'text', text: 'from/toは "YYYY-MM-DD HH:MM" 形式（JST）で指定してください' }] };
  }
  const all = await client.getRecInfo(id);
  if (all.length === 0) {
    return { content: [{ type: 'text', text: id === undefined ? '録画済み番組がありません' : `録画ID ${id} が見つかりません` }] };
  }
  const kw = keyword ? normalizeForSearch(keyword) : undefined;
  const isProblem = (r: RecInfo) => r.recStatus !== REC_END_STATUS_NORMAL || r.drops > 0 || r.scrambles > 0;
  const matched = all.filter(
    (r) =>
      (!kw || normalizeForSearch(r.title).includes(kw)) &&
      (!fromTime || r.starttime >= fromTime) &&
      (!toTime || r.starttime <= toTime) &&
      (only !== 'problem' || isProblem(r))
  );
  const filtered = keyword || from || to || only;
  if (matched.length === 0) {
    return { content: [{ type: 'text', text: `録画済み番組: ${all.length}件\n条件に一致する録画はありません` }] };
  }
  const infos = matched.slice(offset, offset + limit);
  const text = infos
    .map((r) => {
      const start = client.formatTime(r.starttime);
      const dur = client.formatDuration(r.durationSec);
      const status = r.recStatus === REC_END_STATUS_NORMAL ? r.comment : `⚠${r.comment || `録画結果${r.recStatus}`}`;
      const dropInfo = r.drops > 0 ? ` ドロップ:${r.drops}` : '';
      const scrambleInfo = r.scrambles > 0 ? ` スクランブル:${r.scrambles}` : '';
      return `[ID:${r.id}] ${r.title}\n  チャンネル: ${r.service}\n  録画: ${start} (${dur}) ${status}${dropInfo}${scrambleInfo}\n  ファイル: ${r.recFilePath}`;
    })
    .join('\n\n');
  const header = filtered
    ? `録画済み番組: ${all.length}件\n条件に一致: ${pageLabel(matched.length, offset, infos.length)}`
    : `録画済み番組: ${pageLabel(all.length, offset, infos.length)}`;
  return {
    content: [{ type: 'text', text: text ? `${header}\n\n${text}` : header }],
  };
});

// ---- 自動予約一覧 ----
server.registerTool('get_auto_add', {
  description: 'EPGキーワード自動予約（録画予約の自動登録ルール）の一覧を取得します。キーワード・除外キーワード・対象チャンネル・番組長の条件・これまでの追加件数を確認できます。無効にしているルールには（無効）と表示します',
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
      const duration =
        a.durationMin || a.durationMax
          ? `\n  番組長: ${a.durationMin ? `${a.durationMin}分以上` : ''}${a.durationMax ? `${a.durationMax}分以下` : ''}`
          : '';
      return `[ID:${a.id}] キーワード: "${a.keyword}"${a.enabled ? '' : '（無効）'}\n  除外: ${a.notKeyword || 'なし'}\n  対象: ${services || '全チャンネル'}${duration}\n  追加済: ${a.addCount}件`;
    })
    .join('\n\n');
  return {
    content: [{ type: 'text', text: `自動予約数: ${infos.length}\n\n${text}` }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`EDCB MCP Server started (EDCB_URL: ${EDCB_URL}, TCP: ${client.tcpEndpoint})`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
