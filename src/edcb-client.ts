import { CtrlCmdClient, CtrlCmdError, EDCB_TIME_MAX, Reader, i64, systemTimeToDate, toEdcbTime, u32, vec } from './ctrlcmd.js';
import {
  CMD,
  EpgEventInfo,
  enumPgInfoExParam,
  eventKey,
  RecFileInfo,
  RecSettingData,
  ReserveData,
  defaultRecSetting,
  getRecMode,
  isNoRec,
  makeRecMode,
  parseAndKey,
  readAutoAddData,
  readEventInfo,
  readRecFileInfo,
  readReserveData,
  readServiceEventInfo,
  readServiceInfo,
  searchKeyInfo,
  serviceKey,
  writeReserveData,
} from './edcb-structs.js';
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
  /** EDCB独自の指定（無効・番組長など）を取り除いたキーワード */
  keyword: string;
  enabled: boolean;
  /** 番組長の下限（分、0で指定なし） */
  durationMin: number;
  /** 番組長の上限（分、0で指定なし） */
  durationMax: number;
  notKeyword: string;
  titleOnlyFlag: boolean;
  freeCAFlag: number;
  serviceList: Array<{ onid: number; tsid: number; sid: number }>;
  addCount: number;
  recSetting: RecSetting;
}

export interface EdcbClientOptions {
  /** EDCB（EpgTimerSrv）のホスト */
  host: string;
  /** TCP接続（CtrlCmd）のポート */
  port?: number;
  /** チャンネル一覧・番組表を使い回す秒数（0で無効） */
  cacheTtlSec?: number;
}

export interface ServiceId {
  onid: number;
  tsid: number;
  sid: number;
}

/** 予約の追加・変更で指定できる録画設定。指定しなかった項目は変えない */
export interface RecSettingChange {
  recMode?: number;
  priority?: number;
  tuijyuuFlag?: boolean;
  pittariFlag?: boolean;
  suspendMode?: number;
  /** 開始マージン（秒） */
  startMargine?: number;
  /** 終了マージン（秒） */
  endMargine?: number;
}

export interface EventTimeRange {
  from?: Date;
  to?: Date;
}

function toRecSetting(rs: RecSettingData): RecSetting {
  return {
    recEnabled: !isNoRec(rs.recMode),
    recMode: getRecMode(rs.recMode),
    priority: rs.priority,
    tuijyuuFlag: rs.tuijyuuFlag !== 0,
    serviceMode: rs.serviceMode,
    pittariFlag: rs.pittariFlag !== 0,
    batFilePath: rs.batFilePath,
    suspendMode: rs.suspendMode,
    rebootFlag: rs.rebootFlag !== 0,
    useMargineFlag: rs.useMargineFlag !== 0,
    startMargine: rs.startMargine,
    endMargine: rs.endMargine,
    continueRecFlag: rs.continueRecFlag !== 0,
    partialRecFlag: rs.partialRecFlag !== 0,
    tunerID: rs.tunerID,
    recFolderList: rs.recFolderList.map((f) => ({
      recFolder: f.recFolder,
      writePlugIn: f.writePlugIn,
      recNamePlugIn: f.recNamePlugIn,
    })),
  };
}

function toReserveInfo(r: ReserveData): ReserveInfo {
  return {
    id: r.reserveID,
    title: r.title,
    starttime: systemTimeToDate(r.startTime),
    durationSec: r.durationSecond,
    service: r.stationName,
    onid: r.onid,
    tsid: r.tsid,
    sid: r.sid,
    eid: r.eid,
    overlapMode: r.overlapMode,
    comment: r.comment,
    recSetting: toRecSetting(r.recSetting),
  };
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

/** CMD2_EPG_SRV_GET_RESERVE2にこのIDを渡すと、EDCBの既定の設定（マージンなど）が入った予約が返る */
const DEFAULT_RESERVE_ID = 0x7fffffff;

export class EdcbClient {
  private ctrl: CtrlCmdClient;
  private cacheTtlMs: number;
  private cache = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor({ host, port = 4510, cacheTtlSec = 180 }: EdcbClientOptions) {
    this.ctrl = new CtrlCmdClient(host, port);
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
    const r = await this.ctrl.sendVersioned(CMD.ENUM_RESERVE2);
    return r.vec(readReserveData).map(toReserveInfo);
  }

  /** 番組が見つからないときはnullを返す */
  async getEventInfo(onid: number, tsid: number, sid: number, eid: number): Promise<EventInfo | null> {
    const ev = await this.getEpgEvent(onid, tsid, sid, eid);
    if (!ev) return null;
    return toEventInfo(ev, await this.serviceName(onid, tsid, sid));
  }

  /** 番組表にある1番組の情報。見つからなければnull */
  private async getEpgEvent(onid: number, tsid: number, sid: number, eid: number): Promise<EpgEventInfo | null> {
    const data = await this.ctrl.send(CMD.GET_PG_INFO, i64(eventKey(onid, tsid, sid, eid))).catch((e) => {
      if (e instanceof CtrlCmdError && e.isNotFound) return null;
      throw e;
    });
    return data ? readEventInfo(new Reader(data)) : null;
  }

  /** チャンネル一覧にあるサービス名（なければ空文字列） */
  private async serviceName(onid: number, tsid: number, sid: number): Promise<string> {
    const service = (await this.getServices()).find((s) => s.onid === onid && s.tsid === tsid && s.sid === sid);
    return service?.service_name ?? '';
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
    // 番組表があるチャンネルが1つもないと、EDCBは汎用エラーを返す
    const data = await this.ctrl.send(CMD.ENUM_PG_INFO_EX, param).catch((e) => {
      if (e instanceof CtrlCmdError && e.isNotFound) return null;
      throw e;
    });
    if (!data) return [];
    return new Reader(data)
      .vec(readServiceEventInfo)
      .flatMap(({ service, events }) =>
        events.flatMap((e) => {
          const ev = toEventInfo(e, service.service_name);
          return ev ? [ev] : [];
        })
      );
  }

  /**
   * EDCBの番組検索で探す（キーワードは空白区切りでAND、全角半角・大文字小文字を区別しない）。
   * 開始時刻が未定の番組は含めない
   */
  async searchEvents(
    keyword: string,
    services: ServiceId[],
    opts: { notKeyword?: string; titleOnly?: boolean } = {}
  ): Promise<EventInfo[]> {
    if (services.length === 0) return [];
    const param = vec([
      searchKeyInfo({
        andKey: keyword,
        notKey: opts.notKeyword,
        titleOnly: opts.titleOnly,
        serviceKeys: services.map((s) => serviceKey(s.onid, s.tsid, s.sid)),
      }),
    ]);
    const data = await this.ctrl.send(CMD.SEARCH_PG, param);
    const names = new Map((await this.getServices()).map((s) => [`${s.onid}-${s.tsid}-${s.sid}`, s.service_name]));
    return new Reader(data).vec(readEventInfo).flatMap((e) => {
      const ev = toEventInfo(e, names.get(`${e.onid}-${e.tsid}-${e.sid}`) ?? '');
      return ev ? [ev] : [];
    });
  }

  /**
   * 番組を録画予約する。録画設定はEpgTimerの予約設定プリセット「デフォルト」の初期値（defaultRecSetting）で、
   * paramsで指定した項目だけを変える。EDCBは追加した予約のIDを返さないため、予約一覧から探すこと
   */
  async addReserve(onid: number, tsid: number, sid: number, eid: number, params: RecSettingChange = {}): Promise<void> {
    const id = `${onid}-${tsid}-${sid}-${eid}`;
    const ev = await this.getEpgEvent(onid, tsid, sid, eid);
    if (!ev) throw new Error(`番組 ${id} が番組表にありません。get_epgまたはsearch_eventsで確認してください`);
    if (!ev.startTime || ev.durationSec === null) {
      throw new Error(`番組 ${id} は開始時刻か長さが決まっていないため予約できません`);
    }
    if (systemTimeToDate(ev.startTime).getTime() + ev.durationSec * 1000 <= Date.now()) {
      throw new Error(`番組 ${id} は放送が終わっているため予約できません`);
    }
    const recSetting = defaultRecSetting();
    await this.applyRecSettingChange(recSetting, params);
    const reserve: ReserveData = {
      title: ev.eventName,
      startTime: ev.startTime,
      durationSecond: ev.durationSec,
      stationName: await this.serviceName(onid, tsid, sid),
      onid,
      tsid,
      sid,
      eid,
      comment: '',
      reserveID: 0, // EDCBが割り当てる
      overlapMode: 0,
      startTimeEpg: ev.startTime,
      recSetting,
      reserveStatus: 0,
      recFileNameList: [],
    };
    await this.ctrl.sendVersioned(CMD.ADD_RESERVE2, vec([writeReserveData(reserve)]));
  }

  async deleteReserve(id: number): Promise<void> {
    // EDCBは存在しない予約IDの削除も成功として返すため、先に存在を確かめる
    await this.getReserveData(id);
    await this.ctrl.send(CMD.DEL_RESERVE, vec([u32(id)]));
  }

  /** 予約の現在の内容。見つからなければエラー */
  private async getReserveData(id: number): Promise<ReserveData> {
    const r = await this.ctrl.sendVersioned(CMD.GET_RESERVE2, u32(id)).catch((e) => {
      if (e instanceof CtrlCmdError && e.isNotFound) throw new Error(`予約ID ${id} が見つかりません`);
      throw e;
    });
    return readReserveData(r);
  }

  /** 予約の内容を書き換える。dataは現在の内容をもとに、変える項目だけを変えたもの */
  private async putReserveData(data: ReserveData): Promise<void> {
    await this.ctrl.sendVersioned(CMD.CHG_RESERVE2, vec([writeReserveData(data)]));
  }

  async setReserveEnabled(id: number, enabled: boolean): Promise<void> {
    const data = await this.getReserveData(id);
    data.recSetting.recMode = makeRecMode(getRecMode(data.recSetting.recMode), enabled);
    await this.putReserveData(data);
  }

  /** 指定した項目だけを変える（有効・無効の状態は変えない） */
  async changeReserve(id: number, params: RecSettingChange): Promise<void> {
    const data = await this.getReserveData(id);
    await this.applyRecSettingChange(data.recSetting, params);
    await this.putReserveData(data);
  }

  /** 録画設定のうち、paramsで指定した項目だけを変える（有効・無効の状態は変えない） */
  private async applyRecSettingChange(rs: RecSettingData, params: RecSettingChange): Promise<void> {
    if (params.recMode !== undefined) rs.recMode = makeRecMode(params.recMode, !isNoRec(rs.recMode));
    if (params.priority !== undefined) rs.priority = params.priority;
    if (params.tuijyuuFlag !== undefined) rs.tuijyuuFlag = params.tuijyuuFlag ? 1 : 0;
    if (params.pittariFlag !== undefined) rs.pittariFlag = params.pittariFlag ? 1 : 0;
    if (params.suspendMode !== undefined) rs.suspendMode = params.suspendMode;
    if (params.startMargine !== undefined || params.endMargine !== undefined) {
      if (!rs.useMargineFlag) {
        // 既定のマージンを使っていた予約は、指定しなかった側をEDCBの既定値にする
        const def = await this.getReserveData(DEFAULT_RESERVE_ID);
        rs.startMargine = def.recSetting.startMargine;
        rs.endMargine = def.recSetting.endMargine;
      }
      rs.useMargineFlag = 1;
      if (params.startMargine !== undefined) rs.startMargine = params.startMargine;
      if (params.endMargine !== undefined) rs.endMargine = params.endMargine;
    }
  }

  /** 録画済み番組の一覧（開始時刻の新しい順）。idを指定するとその1件だけ */
  async getRecInfo(id?: number): Promise<RecInfo[]> {
    let list: RecFileInfo[];
    if (id === undefined) {
      list = (await this.ctrl.sendVersioned(CMD.ENUM_RECINFO_BASIC2)).vec(readRecFileInfo);
    } else {
      const r = await this.ctrl.sendVersioned(CMD.GET_RECINFO2, u32(id)).catch((e) => {
        if (e instanceof CtrlCmdError && e.isNotFound) return null;
        throw e;
      });
      list = r ? [readRecFileInfo(r)] : [];
    }
    return list
      .map((x) => ({
        id: x.id,
        title: x.title,
        starttime: systemTimeToDate(x.startTime),
        durationSec: x.durationSecond,
        service: x.serviceName,
        onid: x.onid,
        tsid: x.tsid,
        sid: x.sid,
        eid: x.eid,
        recFilePath: x.recFilePath,
        comment: x.comment,
        drops: Number(x.drops),
        scrambles: Number(x.scrambles),
        protect: x.protectFlag,
        recStatus: x.recStatus,
      }))
      .sort((a, b) => b.starttime.getTime() - a.starttime.getTime() || a.id - b.id);
  }

  async getAutoAdd(): Promise<AutoAddInfo[]> {
    const r = await this.ctrl.sendVersioned(CMD.ENUM_AUTO_ADD2);
    return r.vec(readAutoAddData).map((a) => {
      const key = parseAndKey(a.searchInfo.andKey);
      return {
        id: a.dataID,
        keyword: key.keyword,
        enabled: !key.disabled,
        durationMin: key.durationMin,
        durationMax: key.durationMax,
        notKeyword: a.searchInfo.notKey,
        titleOnlyFlag: a.searchInfo.titleOnlyFlag,
        freeCAFlag: a.searchInfo.freeCAFlag,
        serviceList: a.searchInfo.serviceKeys.map((k) => ({
          onid: Number((k >> 32n) & 0xffffn),
          tsid: Number((k >> 16n) & 0xffffn),
          sid: Number(k & 0xffffn),
        })),
        addCount: a.addCount,
        recSetting: toRecSetting(a.recSetting),
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
