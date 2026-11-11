/**
 * EDCBのCtrlCmdで使うコマンド番号と構造体の読み書き。
 * 構造体の並びはEDCBの Common/StructDef.h・Common/CtrlCmdUtil.cpp に合わせる
 */
import { Reader } from './ctrlcmd.js';

/** コマンド番号（EDCBの Common/CtrlCmdDef.h） */
export const CMD = {
  ENUM_SERVICE: 1021,
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
