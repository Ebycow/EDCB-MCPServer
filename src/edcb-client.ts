import axios, { AxiosInstance } from 'axios';
import * as xml2js from 'xml2js';

export interface ServiceInfo {
  onid: number;
  tsid: number;
  sid: number;
  service_type: number;
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
  return {
    recEnabled: bool(r?.recEnabled),
    recMode: num(r?.recMode),
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

export class EdcbClient {
  private http: AxiosInstance;
  private baseUrl: string;
  private parser: xml2js.Parser;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.http = axios.create({ baseURL: this.baseUrl, timeout: 15000 });
    this.parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: false });
  }

  private async fetchXml(path: string, params?: Record<string, string | number | boolean>): Promise<any> {
    const resp = await this.http.get(path, { params, responseType: 'text' });
    const result = await this.parser.parseStringPromise(resp.data);
    const entry = result?.entry;
    if (entry?.err) {
      const err = Array.isArray(entry.err) ? entry.err.join(': ') : entry.err;
      throw new Error(`EDCB Error: ${err}`);
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
      throw new Error(`EDCB Error: ${errs.join(': ')}`);
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
    const entry = await this.fetchXml('/api/EnumService');
    return toArray(entry?.items?.serviceinfo).map((s: any) => ({
      onid: num(s.ONID),
      tsid: num(s.TSID),
      sid: num(s.SID),
      service_type: num(s.service_type),
      service_name: str(s.service_name),
      network_name: str(s.network_name),
      remote_control_key_id: num(s.remote_control_key_id),
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

  async getEventInfo(onid: number, tsid: number, sid: number, eid: number): Promise<EventInfo | null> {
    const entry = await this.fetchXml('/api/EnumEventInfo', {
      id: `${onid}-${tsid}-${sid}-${eid}`,
      basic: 0,
    });
    const events = toArray(entry?.items?.eventinfo);
    if (events.length === 0) return null;
    return this.parseEventInfo(events[0]);
  }

  async getEventsForService(onid: number, tsid: number, sid: number, basic = 1): Promise<EventInfo[]> {
    const entry = await this.fetchXml('/api/EnumEventInfo', {
      id: `${onid}-${tsid}-${sid}`,
      basic,
    });
    return toArray(entry?.items?.eventinfo).map((e: any) => this.parseEventInfo(e));
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
      recMode: rs.recMode || 1,
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

  formatTime(date: Date): string {
    return date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  }

  formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}時間${m}分`;
    return `${m}分`;
  }
}
