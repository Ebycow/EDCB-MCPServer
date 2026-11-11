import axios, { AxiosInstance } from 'axios';
import * as xml2js from 'xml2js';
import { CtrlCmdClient, EDCB_TIME_MAX, Reader, systemTimeToDate, toEdcbTime } from './ctrlcmd.js';
import { CMD, EpgEventInfo, enumPgInfoExParam, readServiceEventInfo, readServiceInfo, serviceKey } from './edcb-structs.js';
import { genreName } from './genres.js';

export interface ServiceInfo {
  onid: number;
  tsid: number;
  sid: number;
  service_type: number;
  /** 部分受信サービス（ワンセグ）かどうか */
  partialReceptionFlag: boolean;
  service_name: string;
  network_name: string;
  remote_control_key_id: number;
}

export interface RecFolder {
  recFolder: string;
  writePlugIn: string;
  recNamePlugIn: string;
}

export interface RecSetting {
  recEnabled: boolean;
  recMode: number;
  priority: number;
  tuijyuuFlag: boolean;
  serviceMode: number;
  pittariFlag: boolean;
  batFilePath: string;
  suspendMode: number;
  rebootFlag: boolean;
  useMargineFlag: boolean;
  startMargine: number;
  endMargine: number;
  continueRecFlag: boolean;
  partialRecFlag: boolean;
  tunerID: number;
  recFolderList: RecFolder[];
}

export interface ReserveInfo {
  id: number;
  title: string;
  starttime: Date;
  durationSec: number;
  service: string;
  onid: number;
  tsid: number;
  sid: number;
  eid: number;
  overlapMode: number;
  comment: string;
  recSetting: RecSetting;
}

export interface EventInfo {
  onid: number;
  tsid: number;
  sid: number;
  eid: number;
  title: string;
  service: string;
  starttime: Date;
  durationSec: number;
  text: string;
  /** 詳細情報（get_event_info用。番組表の一覧では空のことがある） */
  extText: string;
  /** trueでスクランブル（有料）、falseで無料放送 */
  freeCAFlag: boolean;
  genre: Array<{ nibble1: number; nibble2: number; component_type_name: string }>;
}

export interface RecInfo {
  id: number;
  title: string;
  starttime: Date;
  durationSec: number;
  service: string;
  onid: number;
  tsid: number;
  sid: number;
  eid: number;
  recFilePath: string;
  comment: string;
  drops: number;
  scrambles: number;
  protect: boolean;
  recStatus: number;
}

export interface AutoAddInfo {
  id: number;
  keyword: string;
  notKeyword: string;
  titleOnlyFlag: boolean;
  freeCAFlag: number;
  serviceList: Array<{ onid: number; tsid: number; sid: number }>;
  addCount: number;
  recSetting: RecSetting;
}

/** EDCB（EMWUI）が<err>で返したエラー */
export class EdcbError extends Error {
  constructor(readonly detail: string) {
    super(`EDCB Error: ${detail}`);
  }

  /** 番組・チャンネルの番組表が見つからないときのエラーか（EDCBは原因を区別せずこのメッセージを返す） */
  get isEpgNotFound(): boolean {
    return this.detail.includes('EPGデータを読み込み中、または存在しません');
  }
}

function parseDate(startDate: string, startTime: string): Date {
  const dateStr = `${startDate.replace(/\//g, '-')}T${startTime}+09:00`;
  return new Date(dateStr);
}

function num(val: string | string[] | undefined): number {
  const s = Array.isArray(val) ? val[0] : val;
  return parseInt(s ?? '0', 10) || 0;
}

function str(val: string | string[] | undefined): string {
  if (Array.isArray(val)) return val[0] ?? '';
  return val ?? '';
}

function bool(val: string | string[] | undefined): boolean {
  const s = Array.isArray(val) ? val[0] : val;
  return s === '1' || s === 'true';
}

function toArray<T>(val: T | T[] | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function parseRecSetting(r: any): RecSetting {
  const folders = toArray(r?.recFolderList?.recFolderInfo);
  // EMWUIの新しいAPIは<recEnabled>を返すが、古いAPIは返さず recMode=5 で無効を表す
  const rawMode = num(r?.recMode);
  const recEnabled = r?.recEnabled !== undefined ? bool(r.recEnabled) : rawMode !== 5;
  return {
    recEnabled,
    recMode: rawMode,
    priority: num(r?.priority),
    tuijyuuFlag: bool(r?.tuijyuuFlag),
    serviceMode: num(r?.serviceMode),
    pittariFlag: bool(r?.pittariFlag),
    batFilePath: str(r?.batFilePath),
    suspendMode: num(r?.suspendMode),
    rebootFlag: bool(r?.rebootFlag),
    useMargineFlag: bool(r?.useMargineFlag),
    startMargine: num(r?.startMargine),
    endMargine: num(r?.endMargine),
    continueRecFlag: bool(r?.continueRecFlag),
    partialRecFlag: bool(r?.partialRecFlag),
    tunerID: num(r?.tunerID),
    recFolderList: folders.map((f: any) => ({
      recFolder: str(f?.recFolder),
      writePlugIn: str(f?.writePlugIn),
      recNamePlugIn: str(f?.recNamePlugIn),
    })),
  };
}

export interface EdcbClientOptions {
  /** EDCBのHTTPサーバー（Material WebUI）のURL */
  url: string;
  /** TCP接続（CtrlCmd）のホスト。省略時はurlのホスト */
  tcpHost?: string;
  /** TCP接続（CtrlCmd）のポート */
  tcpPort?: number;
  /** チャンネル一覧・番組表を使い回す秒数（0で無効） */
  cacheTtlSec?: number;
}

export interface ServiceId {
  onid: number;
  tsid: number;
  sid: number;
}

export interface EventTimeRange {
  from?: Date;
  to?: Date;
}

/** TCPで取得した番組をEventInfoにする。開始時刻が未定の番組はnull */
function toEventInfo(e: EpgEventInfo, serviceName: string): EventInfo | null {
  if (!e.startTime) return null;
  return {
    onid: e.onid,
    tsid: e.tsid,
    sid: e.sid,
    eid: e.eid,
    title: e.eventName,
    service: serviceName,
    starttime: systemTimeToDate(e.startTime),
    durationSec: e.durationSec ?? 0,
    text: e.text,
    extText: e.extText,
    freeCAFlag: e.freeCAFlag,
    genre: e.genres.flatMap((g) => {
      const name = genreName(g.nibble1, g.nibble2);
      return name === null ? [] : [{ nibble1: g.nibble1, nibble2: g.nibble2, component_type_name: name }];
    }),
  };
}

export class EdcbClient {
  private http: AxiosInstance;
  private baseUrl: string;
  private parser: xml2js.Parser;
  private ctrl: CtrlCmdClient;
  private cacheTtlMs: number;
  private cache = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor({ url, tcpHost, tcpPort = 4510, cacheTtlSec = 180 }: EdcbClientOptions) {
    this.baseUrl = url.replace(/\/$/, '');
    this.http = axios.create({ baseURL: this.baseUrl, timeout: 15000 });
    this.parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: false });
    this.ctrl = new CtrlCmdClient(tcpHost || new URL(this.baseUrl).hostname, tcpPort);
    this.cacheTtlMs = cacheTtlSec * 1000;
  }

  /** TCP接続（CtrlCmd）の接続先（"host:port"） */
  get tcpEndpoint(): string {
    return `${this.ctrl.host}:${this.ctrl.port}`;
  }

  /** 同じキーの取得結果を一定時間使い回す（同時に来た要求も1回の取得にまとめる）。失敗した結果は残さない */
  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.cacheTtlMs <= 0) return load();
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { expires: now + this.cacheTtlMs, value });
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }

  private async fetchXml(path: string, params?: Record<string, string | number | boolean>): Promise<any> {
    const resp = await this.http.get(path, { params, responseType: 'text' });
    const result = await this.parser.parseStringPromise(resp.data);
    const entry = result?.entry;
    if (entry?.err) {
      const err = Array.isArray(entry.err) ? entry.err.join(': ') : entry.err;
      throw new EdcbError(err);
    }
    return entry;
  }

  private async postForm(
    path: string,
    body: Record<string, string | number | boolean>,
    params?: Record<string, string | number>
  ): Promise<any> {
    const bodyStr = Object.entries(body)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const resp = await this.http.post(path, bodyStr, {
      params,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(bodyStr, 'utf8')),
      },
      responseType: 'text',
    });
    const result = await this.parser.parseStringPromise(resp.data);
    const entry = result?.entry;
    if (entry?.err) {
      const errs = toArray(entry.err);
      throw new EdcbError(errs.join(': '));
    }
    return entry;
  }

  async getCsrfToken(): Promise<string> {
    const resp = await this.http.get('/EMWUI/reserve.html', { responseType: 'text' });
    const match = (resp.data as string).match(/ctok='([a-f0-9]+)'/);
    if (!match) throw new Error('CSRFトークンを取得できませんでした');
    return match[1];
  }

  async getServices(): Promise<ServiceInfo[]> {
    const services = await this.cached('services', () => this.fetchServices());
    return services.slice();
  }

  private async fetchServices(): Promise<ServiceInfo[]> {
    const data = await this.ctrl.send(CMD.ENUM_SERVICE);
    return new Reader(data).vec(readServiceInfo).map((s) => ({
      onid: s.onid,
      tsid: s.tsid,
      sid: s.sid,
      service_type: s.service_type,
      partialReceptionFlag: s.partialReceptionFlag,
      service_name: s.service_name,
      network_name: s.network_name,
      remote_control_key_id: s.remote_control_key_id,
    }));
  }

  async getReserves(): Promise<ReserveInfo[]> {
    const entry = await this.fetchXml('/api/EnumReserveInfo');
    return toArray(entry?.items?.reserveinfo).map((r: any) => ({
      id: num(r.ID),
      title: str(r.title),
      starttime: parseDate(str(r.startDate), str(r.startTime)),
      durationSec: num(r.duration),
      service: str(r.service_name),
      onid: num(r.ONID),
      tsid: num(r.TSID),
      sid: num(r.SID),
      eid: num(r.eventID),
      overlapMode: num(r.overlapMode),
      comment: str(r.comment),
      recSetting: parseRecSetting(r.recsetting),
    }));
  }

  /** 番組が見つからないときはnullを返す */
  async getEventInfo(onid: number, tsid: number, sid: number, eid: number): Promise<EventInfo | null> {
    const entry = await this.fetchXml('/api/EnumEventInfo', {
      id: `${onid}-${tsid}-${sid}-${eid}`,
      basic: 0,
    }).catch((e) => {
      if (e instanceof EdcbError && e.isEpgNotFound) return null;
      throw e;
    });
    const events = toArray(entry?.items?.eventinfo);
    if (events.length === 0) return null;
    return this.parseEventInfo(events[0]);
  }

  /** 1チャンネルの番組表。番組表がないチャンネルは空配列を返す */
  async getEventsForService(onid: number, tsid: number, sid: number, range?: EventTimeRange): Promise<EventInfo[]> {
    return this.getEvents([{ onid, tsid, sid }], range);
  }

  /**
   * 複数チャンネルの番組表を1回の通信で取得する。開始時刻が未定の番組は含めない。
   * rangeは番組の開始時刻で絞り込む（from以上・to未満）
   */
  async getEvents(services: ServiceId[], range: EventTimeRange = {}): Promise<EventInfo[]> {
    if (services.length === 0) return [];
    const param = enumPgInfoExParam(
      services.map((s) => serviceKey(s.onid, s.tsid, s.sid)),
      range.from ? toEdcbTime(range.from) : 0n,
      range.to ? toEdcbTime(range.to) : EDCB_TIME_MAX
    );
    const data = await this.ctrl.send(CMD.ENUM_PG_INFO_EX, param);
    return new Reader(data)
      .vec(readServiceEventInfo)
      .flatMap(({ service, events }) =>
        events.flatMap((e) => {
          const ev = toEventInfo(e, service.service_name);
          return ev ? [ev] : [];
        })
      );
  }

  private parseEventInfo(e: any): EventInfo {
    const genres = toArray(e.contentInfo);
    return {
      onid: num(e.ONID),
      tsid: num(e.TSID),
      sid: num(e.SID),
      eid: num(e.eventID),
      title: str(e.event_name) || str(e.title),
      service: str(e.service_name),
      starttime: parseDate(str(e.startDate), str(e.startTime)),
      durationSec: num(e.duration),
      text: str(e.event_text),
      extText: '',
      freeCAFlag: bool(e.freeCAFlag),
      genre: genres.map((g: any) => ({
        nibble1: num(g.nibble1),
        nibble2: num(g.nibble2),
        component_type_name: str(g.component_type_name),
      })),
    };
  }

  async searchEvents(keyword: string, serviceIds?: Array<{ onid: number; tsid: number; sid: number }>): Promise<EventInfo[]> {
    const ctok = await this.getCsrfToken();
    const body: Record<string, string | number | boolean> = {
      ctok,
      andKey: keyword,
    };
    if (serviceIds && serviceIds.length > 0) {
      // Note: multiple serviceList values need special handling
      // We use URLSearchParams manually
      const params = new URLSearchParams();
      params.append('ctok', ctok);
      params.append('andKey', keyword);
      for (const s of serviceIds) {
        params.append('serviceList', `${s.onid}-${s.tsid}-${s.sid}`);
      }
      const bodyStr = params.toString();
      const resp = await this.http.post('/api/SearchEvent', bodyStr, {
        params: { basic: 1 },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': String(Buffer.byteLength(bodyStr, 'utf8')),
        },
        responseType: 'text',
      });
      const result = await this.parser.parseStringPromise(resp.data);
      const entry = result?.entry;
      return toArray(entry?.items?.eventinfo).map((e: any) => this.parseEventInfo(e));
    }

    const bodyStr = Object.entries(body)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const resp = await this.http.post('/api/SearchEvent', bodyStr, {
      params: { basic: 1 },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(bodyStr, 'utf8')),
      },
      responseType: 'text',
    });
    const result = await this.parser.parseStringPromise(resp.data);
    const entry = result?.entry;
    return toArray(entry?.items?.eventinfo).map((e: any) => this.parseEventInfo(e));
  }

  async addReserve(onid: number, tsid: number, sid: number, eid: number): Promise<number> {
    // Uses oneclick=1 which applies the default preset settings
    const ctok = await this.getCsrfToken();
    const entry = await this.fetchXml('/api/SetReserve', {
      oneclick: 1,
      onid,
      tsid,
      sid,
      eid,
      ctok,
    });
    return num(entry?.reserveinfo?.ID);
  }

  async deleteReserve(id: number): Promise<void> {
    const ctok = await this.getCsrfToken();
    await this.postForm('/api/SetReserve', { ctok, del: 1 }, { id });
  }

  async setReserveEnabled(id: number, enabled: boolean): Promise<void> {
    const reserves = await this.getReserves();
    const reserve = reserves.find((r) => r.id === id);
    if (!reserve) throw new Error(`予約ID ${id} が見つかりません`);

    const ctok = await this.getCsrfToken();
    const rs = reserve.recSetting;
    const body: Record<string, string | number | boolean> = {
      ctok,
      change: 1,
      recEnabled: enabled ? 1 : 0,
      recMode: rs.recMode >= 0 && rs.recMode <= 4 ? rs.recMode : 1,
      priority: rs.priority || 2,
      tuijyuuFlag: rs.tuijyuuFlag ? 1 : 0,
      pittariFlag: rs.pittariFlag ? 1 : 0,
      suspendMode: rs.suspendMode ?? 0,
      rebootFlag: rs.rebootFlag ? 1 : 0,
      tunerID: rs.tunerID ?? 0,
      startMargin: rs.startMargine ?? 0,
      endMargin: rs.endMargine ?? 0,
    };
    await this.postForm('/api/SetReserve', body, { id });
  }

  async changeReserve(
    id: number,
    params: {
      recMode?: number;
      priority?: number;
      tuijyuuFlag?: boolean;
      pittariFlag?: boolean;
      suspendMode?: number;
      startMargine?: number;
      endMargine?: number;
    }
  ): Promise<void> {
    const ctok = await this.getCsrfToken();
    const body: Record<string, string | number | boolean> = {
      ctok,
      change: 1,
      recEnabled: 1,
    };
    if (params.recMode !== undefined) body['recMode'] = params.recMode;
    if (params.priority !== undefined) body['priority'] = params.priority;
    if (params.tuijyuuFlag !== undefined) body['tuijyuuFlag'] = params.tuijyuuFlag ? 1 : 0;
    if (params.pittariFlag !== undefined) body['pittariFlag'] = params.pittariFlag ? 1 : 0;
    if (params.suspendMode !== undefined) body['suspendMode'] = params.suspendMode;
    if (params.startMargine !== undefined) body['startMargin'] = params.startMargine;
    if (params.endMargine !== undefined) body['endMargin'] = params.endMargine;

    // Need at least recMode, priority, suspendMode, tunerID for validation
    if (!body['recMode']) body['recMode'] = 1;
    if (!body['priority']) body['priority'] = 2;
    if (body['suspendMode'] === undefined) body['suspendMode'] = 0;
    body['tunerID'] = 0;
    body['pittariFlag'] = body['pittariFlag'] ?? 0;
    body['tuijyuuFlag'] = body['tuijyuuFlag'] ?? 1;
    body['rebootFlag'] = 0;

    if (body['startMargin'] !== undefined && body['endMargin'] !== undefined) {
      // explicit margins provided, no useDefMarginFlag
    } else {
      // Use margin=0 as default
      body['startMargin'] = 0;
      body['endMargin'] = 0;
    }

    await this.postForm('/api/SetReserve', body, { id });
  }

  async getRecInfo(id?: number): Promise<RecInfo[]> {
    const params: Record<string, number> = {};
    if (id !== undefined) params['id'] = id;
    const entry = await this.fetchXml('/api/EnumRecInfo', params);
    return toArray(entry?.items?.recinfo).map((r: any) => ({
      id: num(r.ID),
      title: str(r.title),
      starttime: parseDate(str(r.startDate), str(r.startTime)),
      durationSec: num(r.duration),
      service: str(r.service_name),
      onid: num(r.ONID),
      tsid: num(r.TSID),
      sid: num(r.SID),
      eid: num(r.eventID),
      recFilePath: str(r.recFilePath),
      comment: str(r.comment),
      drops: num(r.drops),
      scrambles: num(r.scrambles),
      protect: bool(r.protect),
      recStatus: num(r.recStatus),
    }));
  }

  async getAutoAdd(): Promise<AutoAddInfo[]> {
    const entry = await this.fetchXml('/api/EnumAutoAdd');
    return toArray(entry?.items?.autoaddinfo).map((a: any) => {
      const ss = a.searchsetting ?? {};
      return {
        id: num(a.ID),
        keyword: str(ss.andKey),
        notKeyword: str(ss.notKey),
        titleOnlyFlag: bool(ss.titleOnlyFlag),
        freeCAFlag: num(ss.freeCAFlag),
        serviceList: toArray(ss.serviceList).map((s: any) => ({
          onid: num(s.onid),
          tsid: num(s.tsid),
          sid: num(s.sid),
        })),
        addCount: num(a.addCount),
        recSetting: parseRecSetting(a.recsetting),
      };
    });
  }

  /** JSTの "YYYY-MM-DD HH:MM" 形式（ツールの日時入力と同じ形式）にする */
  formatTime(date: Date): string {
    const jst = new Date(date.getTime() + 9 * 3600 * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())} ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`;
  }

  formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}時間${m}分`;
    return `${m}分`;
  }
}
