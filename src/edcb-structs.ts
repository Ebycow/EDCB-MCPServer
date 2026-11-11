/**
 * EDCBのCtrlCmdで使うコマンド番号と構造体の読み書き。
 * 構造体の並びはEDCBの Common/StructDef.h・Common/CtrlCmdUtil.cpp に合わせる
 */
import { Reader, SystemTime, i32, i64, struct, u8, vec, wstr } from './ctrlcmd.js';

/** コマンド番号（EDCBの Common/CtrlCmdDef.h） */
export const CMD = {
  ENUM_SERVICE: 1021,
  SEARCH_PG: 1025,
  ENUM_PG_INFO_EX: 1029,
} as const;

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
