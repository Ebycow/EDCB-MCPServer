/**
 * EDCBのCtrlCmdで使うコマンド番号と構造体の読み書き。
 * 構造体の並びはEDCBの Common/StructDef.h・Common/CtrlCmdUtil.cpp に合わせる
 */
import { Reader, SystemTime, i32, i64, struct, systemTime, u16, u32, u8, vec, wstr } from './ctrlcmd.js';

/** コマンド番号（EDCBの Common/CtrlCmdDef.h） */
export const CMD = {
  ENUM_RESERVE2: 2011,
  GET_RESERVE2: 2012,
  CHG_RESERVE2: 2015,
  DEL_RESERVE: 1014,
  ENUM_SERVICE: 1021,
  GET_PG_INFO: 1023,
  SEARCH_PG: 1025,
  ENUM_PG_INFO_EX: 1029,
} as const;

/** 番組のキー（onid<<48 | tsid<<32 | sid<<16 | eid） */
export function eventKey(onid: number, tsid: number, sid: number, eid: number): bigint {
  return (serviceKey(onid, tsid, sid) << 16n) | BigInt(eid);
}

/** サービスのキー（onid<<32 | tsid<<16 | sid） */
export function serviceKey(onid: number, tsid: number, sid: number): bigint {
  return (BigInt(onid) << 32n) | (BigInt(tsid) << 16n) | BigInt(sid);
}

export interface EpgServiceInfo {
  onid: number;
  tsid: number;
  sid: number;
  service_type: number;
  partialReceptionFlag: boolean;
  service_provider_name: string;
  service_name: string;
  network_name: string;
  ts_name: string;
  remote_control_key_id: number;
}

/** EPGDB_SERVICE_INFO */
export function readServiceInfo(r: Reader): EpgServiceInfo {
  return r.struct((s) => ({
    onid: s.u16(),
    tsid: s.u16(),
    sid: s.u16(),
    service_type: s.u8(),
    partialReceptionFlag: s.u8() !== 0,
    service_provider_name: s.wstr(),
    service_name: s.wstr(),
    network_name: s.wstr(),
    ts_name: s.wstr(),
    remote_control_key_id: s.u8(),
  }));
}

export interface EpgEventInfo {
  onid: number;
  tsid: number;
  sid: number;
  eid: number;
  /** 開始時刻が未定ならnull */
  startTime: SystemTime | null;
  /** 長さが未定ならnull */
  durationSec: number | null;
  eventName: string;
  text: string;
  /** 詳細情報（拡張形式イベント記述子） */
  extText: string;
  genres: Array<{ nibble1: number; nibble2: number }>;
  /** trueでスクランブル（有料） */
  freeCAFlag: boolean;
}

/** EPGDB_EVENT_INFO（番組表で使わないコンポーネント・音声・イベントグループは読み飛ばす） */
export function readEventInfo(r: Reader): EpgEventInfo {
  return r.struct((s) => {
    const onid = s.u16();
    const tsid = s.u16();
    const sid = s.u16();
    const eid = s.u16();
    const hasStart = s.u8() !== 0;
    const start = s.systemTime();
    const hasDuration = s.u8() !== 0;
    const duration = s.u32();
    const short = s.struct((x) => (x.done ? null : { name: x.wstr(), text: x.wstr() }));
    const extText = s.struct((x) => (x.done ? '' : x.wstr()));
    const genres = s.struct((x) =>
      x.done ? [] : x.vec((c) => c.struct((d) => ({ nibble1: d.u8(), nibble2: d.u8() })))
    );
    s.struct(() => null); // componentInfo
    s.struct(() => null); // audioInfo
    s.struct(() => null); // eventGroupInfo
    s.struct(() => null); // eventRelayInfo
    return {
      onid,
      tsid,
      sid,
      eid,
      startTime: hasStart ? start : null,
      durationSec: hasDuration ? duration : null,
      eventName: short?.name ?? '',
      text: short?.text ?? '',
      extText,
      genres,
      freeCAFlag: s.u8() !== 0,
    };
  });
}

/** EPGDB_SERVICE_EVENT_INFO */
export function readServiceEventInfo(r: Reader): { service: EpgServiceInfo; events: EpgEventInfo[] } {
  return r.struct((s) => ({ service: readServiceInfo(s), events: s.vec(readEventInfo) }));
}

/**
 * CMD2_EPG_SRV_ENUM_PG_INFO_EXの引数。サービスごとに[マスク, キー]の組を並べ、最後に開始時刻の範囲を付ける
 * （EDCBは (サービスキー | マスク) == キー で照合する）
 */
export function enumPgInfoExParam(serviceKeys: bigint[], enumStart: bigint, enumEnd: bigint): Buffer {
  return vec([...serviceKeys.flatMap((k) => [i64(0), i64(k)]), i64(enumStart), i64(enumEnd)]);
}

export interface SearchKey {
  /** 検索キーワード（空白区切りでAND） */
  andKey: string;
  /** 除外キーワード */
  notKey?: string;
  /** タイトルのみを検索する（falseなら番組説明・詳細情報も検索する） */
  titleOnly?: boolean;
  /** 検索対象のサービスのキー（EDCBは空だと何も返さない） */
  serviceKeys: bigint[];
}

/** EPGDB_SEARCH_KEY_INFO（CMD2_EPG_SRV_SEARCH_PGはバージョン0の形式で読む） */
export function searchKeyInfo(key: SearchKey): Buffer {
  return struct(
    wstr(key.andKey),
    wstr(key.notKey ?? ''),
    i32(0), // regExpFlag
    i32(key.titleOnly ? 1 : 0),
    vec([]), // contentList
    vec([]), // dateList
    vec(key.serviceKeys.map((k) => i64(k))),
    vec([]), // videoList
    vec([]), // audioList
    u8(0), // aimaiFlag
    u8(0), // notContetFlag
    u8(0), // notDateFlag
    u8(0) // freeCAFlag
  );
}

/** REC_FILE_SET_INFO */
export interface RecFileSetInfo {
  recFolder: string;
  writePlugIn: string;
  recNamePlugIn: string;
  recFileName: string;
}

/** REC_SETTING_DATA（CMD_VER 2以降の形式） */
export interface RecSettingData {
  /** 録画モード。無効のときは5以上の値で、元の録画モードも含む（isNoRec・getRecModeで解釈する） */
  recMode: number;
  priority: number;
  tuijyuuFlag: number;
  serviceMode: number;
  pittariFlag: number;
  batFilePath: string;
  recFolderList: RecFileSetInfo[];
  suspendMode: number;
  rebootFlag: number;
  useMargineFlag: number;
  startMargine: number;
  endMargine: number;
  continueRecFlag: number;
  partialRecFlag: number;
  tunerID: number;
  partialRecFolder: RecFileSetInfo[];
}

/** REC_SETTING_DATA::DIV_RECMODE */
const DIV_RECMODE = 5;

/** 予約が無効か（REC_SETTING_DATA::IsNoRec） */
export function isNoRec(recMode: number): boolean {
  return Math.floor(recMode / DIV_RECMODE) % 2 !== 0;
}

/** 無効かどうかを除いた録画モード（REC_SETTING_DATA::GetRecMode） */
export function getRecMode(recMode: number): number {
  return (recMode + (Math.floor(recMode / DIV_RECMODE) % 2)) % DIV_RECMODE;
}

/** 録画モードと有効・無効からrecModeの値を作る（getRecMode・isNoRecの逆） */
export function makeRecMode(mode: number, enabled: boolean): number {
  return enabled ? mode : DIV_RECMODE + ((mode + DIV_RECMODE - 1) % DIV_RECMODE);
}

/** RESERVE_DATA（CMD_VER 5の形式） */
export interface ReserveData {
  title: string;
  startTime: SystemTime;
  durationSecond: number;
  stationName: string;
  onid: number;
  tsid: number;
  sid: number;
  eid: number;
  comment: string;
  reserveID: number;
  overlapMode: number;
  startTimeEpg: SystemTime;
  recSetting: RecSettingData;
  reserveStatus: number;
  recFileNameList: string[];
}

function readRecFileSetInfo(r: Reader): RecFileSetInfo {
  return r.struct((s) => ({ recFolder: s.wstr(), writePlugIn: s.wstr(), recNamePlugIn: s.wstr(), recFileName: s.wstr() }));
}

function writeRecFileSetInfo(f: RecFileSetInfo): Buffer {
  return struct(wstr(f.recFolder), wstr(f.writePlugIn), wstr(f.recNamePlugIn), wstr(f.recFileName));
}

export function writeRecSetting(rs: RecSettingData): Buffer {
  return struct(
    u8(rs.recMode),
    u8(rs.priority),
    u8(rs.tuijyuuFlag),
    u32(rs.serviceMode),
    u8(rs.pittariFlag),
    wstr(rs.batFilePath),
    vec(rs.recFolderList.map(writeRecFileSetInfo)),
    u8(rs.suspendMode),
    u8(rs.rebootFlag),
    u8(rs.useMargineFlag),
    i32(rs.startMargine),
    i32(rs.endMargine),
    u8(rs.continueRecFlag),
    u8(rs.partialRecFlag),
    u32(rs.tunerID),
    vec(rs.partialRecFolder.map(writeRecFileSetInfo))
  );
}

/** RESERVE_DATAをCMD_VER 5の形式で書く */
export function writeReserveData(r: ReserveData): Buffer {
  return struct(
    wstr(r.title),
    systemTime(r.startTime),
    u32(r.durationSecond),
    wstr(r.stationName),
    u16(r.onid),
    u16(r.tsid),
    u16(r.sid),
    u16(r.eid),
    wstr(r.comment),
    u32(r.reserveID),
    u8(0), // presentFlag（内部用）
    u8(r.overlapMode),
    wstr(''), // recFilePath（廃止）
    systemTime(r.startTimeEpg),
    writeRecSetting(r.recSetting),
    u32(r.reserveStatus),
    vec(r.recFileNameList.map(wstr)),
    u32(0) // param1（将来用）
  );
}

export function readRecSetting(r: Reader): RecSettingData {
  return r.struct((s) => ({
    recMode: s.u8(),
    priority: s.u8(),
    tuijyuuFlag: s.u8(),
    serviceMode: s.u32(),
    pittariFlag: s.u8(),
    batFilePath: s.wstr(),
    recFolderList: s.vec(readRecFileSetInfo),
    suspendMode: s.u8(),
    rebootFlag: s.u8(),
    useMargineFlag: s.u8(),
    startMargine: s.i32(),
    endMargine: s.i32(),
    continueRecFlag: s.u8(),
    partialRecFlag: s.u8(),
    tunerID: s.u32(),
    partialRecFolder: s.done ? [] : s.vec(readRecFileSetInfo),
  }));
}

export function readReserveData(r: Reader): ReserveData {
  return r.struct((s) => {
    const title = s.wstr();
    const startTime = s.systemTime();
    const durationSecond = s.u32();
    const stationName = s.wstr();
    const onid = s.u16();
    const tsid = s.u16();
    const sid = s.u16();
    const eid = s.u16();
    const comment = s.wstr();
    const reserveID = s.u32();
    s.u8(); // presentFlag（内部用）
    const overlapMode = s.u8();
    s.wstr(); // recFilePath（廃止）
    const startTimeEpg = s.systemTime();
    const recSetting = readRecSetting(s);
    const reserveStatus = s.u32();
    const recFileNameList = s.done ? [] : s.vec((x) => x.wstr());
    if (!s.done) s.u32(); // param1（将来用）
    return {
      title,
      startTime,
      durationSecond,
      stationName,
      onid,
      tsid,
      sid,
      eid,
      comment,
      reserveID,
      overlapMode,
      startTimeEpg,
      recSetting,
      reserveStatus,
      recFileNameList,
    };
  });
}
