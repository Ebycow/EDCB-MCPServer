/**
 * EDCB（EpgTimerSrv）のTCP接続（CtrlCmd）の送受信と、バイナリ形式の読み書き。
 *
 * 形式はEDCBの Common/CtrlCmdUtil.cpp に合わせる。
 * - 送受信: [u32 コマンド/結果][u32 データ長][データ]（リトルエンディアン）。1接続につき1コマンド
 * - 構造体: 先頭に自身を含む全体のバイト数（u32）が付く。知らないフィールドは読み飛ばせる
 * - 配列: [u32 全体のバイト数][u32 個数][要素...]
 * - 文字列: [u32 全体のバイト数][UTF-16LE、終端の0を含む]
 * - 2000番台のコマンドは、データの先頭にバージョン（u16）が付く
 */
import * as net from 'net';

/** 2000番台のコマンドで使う形式のバージョン（EDCBのCMD_VER） */
export const CMD_VER = 5;

const CMD_SUCCESS = 1;

const CMD_ERROR_MESSAGES: Record<number, string> = {
  0: '失敗しました',
  203: '未サポートのコマンドです',
  204: '引数が正しくありません',
  208: 'EPGデータを読み込み中です。しばらく待ってから再度実行してください',
};

/** EDCBがCMD_SUCCESS以外を返したときのエラー */
export class CtrlCmdError extends Error {
  constructor(readonly command: number, readonly code: number) {
    super(`EDCB Error: ${CMD_ERROR_MESSAGES[code] ?? `エラーコード${code}`}（コマンド${command}）`);
  }

  /** 番組・予約などが見つからなかったときのエラーか（EDCBは見つからないときに汎用エラーを返す） */
  get isNotFound(): boolean {
    return this.code === 0;
  }
}

// ---------- 書き込み ----------

export const u8 = (v: number): Buffer => Buffer.from([v & 0xff]);
export const u16 = (v: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
export const u32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
export const i32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v);
  return b;
};
export const i64 = (v: bigint | number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
};
export function wstr(s: string): Buffer {
  const body = Buffer.from(`${s}\0`, 'utf16le');
  return Buffer.concat([u32(body.length + 4), body]);
}
/** サイズ付きの構造体 */
export function struct(...fields: Buffer[]): Buffer {
  const body = Buffer.concat(fields);
  return Buffer.concat([u32(body.length + 4), body]);
}
export function vec(items: Buffer[]): Buffer {
  const body = Buffer.concat(items);
  return Buffer.concat([u32(body.length + 8), u32(items.length), body]);
}

/** EDCBのSYSTEMTIME（JSTの各フィールド） */
export interface SystemTime {
  year: number;
  month: number;
  dayOfWeek: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  milliseconds: number;
}

export function systemTime(t: SystemTime): Buffer {
  return Buffer.concat([t.year, t.month, t.dayOfWeek, t.day, t.hour, t.minute, t.second, t.milliseconds].map(u16));
}

const JST_OFFSET_MS = 9 * 3600 * 1000;

export function systemTimeToDate(t: SystemTime): Date {
  return new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second, t.milliseconds) - JST_OFFSET_MS);
}

/** EDCBの時刻値（JSTを1601年からの100ナノ秒単位で表したもの）にする */
export function toEdcbTime(d: Date): bigint {
  return BigInt(d.getTime() + JST_OFFSET_MS) * 10000n + 116444736000000000n;
}

/** EDCBの時刻値の最大（範囲指定で「上限なし」に使う） */
export const EDCB_TIME_MAX = 0x7fffffffffffffffn;

// ---------- 読み込み ----------

export class Reader {
  constructor(private readonly buf: Buffer, private pos = 0, private readonly end = buf.length) {}

  /** 読み終えたか（構造体の末尾に、古いバージョンにないフィールドがあるかの判定に使う） */
  get done(): boolean {
    return this.pos >= this.end;
  }

  private take(n: number): number {
    if (this.pos + n > this.end) throw new Error('EDCBの応答が途中で切れています');
    const p = this.pos;
    this.pos += n;
    return p;
  }

  u8(): number {
    return this.buf[this.take(1)];
  }
  u16(): number {
    return this.buf.readUInt16LE(this.take(2));
  }
  u32(): number {
    return this.buf.readUInt32LE(this.take(4));
  }
  i32(): number {
    return this.buf.readInt32LE(this.take(4));
  }
  i64(): bigint {
    return this.buf.readBigInt64LE(this.take(8));
  }

  wstr(): string {
    const size = this.u32();
    if (size < 4) throw new Error('EDCBの応答の文字列が不正です');
    const bodyStart = this.pos;
    this.take(size - 4);
    // 終端の0までを文字列とする
    let e = bodyStart;
    while (e + 1 < this.pos && (this.buf[e] || this.buf[e + 1])) e += 2;
    return this.buf.toString('utf16le', bodyStart, e);
  }

  systemTime(): SystemTime {
    return {
      year: this.u16(),
      month: this.u16(),
      dayOfWeek: this.u16(),
      day: this.u16(),
      hour: this.u16(),
      minute: this.u16(),
      second: this.u16(),
      milliseconds: this.u16(),
    };
  }

  /** サイズ付きの構造体を読む。readFieldsには構造体の中だけを読むReaderを渡し、読み残しは飛ばす */
  struct<T>(readFields: (r: Reader) => T): T {
    const start = this.pos;
    const size = this.u32();
    if (size < 4 || start + size > this.end) throw new Error('EDCBの応答の構造体が不正です');
    this.pos = start + size;
    return readFields(new Reader(this.buf, start + 4, start + size));
  }

  vec<T>(readItem: (r: Reader) => T): T[] {
    const start = this.pos;
    const size = this.u32();
    const count = this.u32();
    if (size < 8 || start + size > this.end) throw new Error('EDCBの応答の配列が不正です');
    const inner = new Reader(this.buf, start + 8, start + size);
    const items: T[] = [];
    for (let i = 0; i < count; i++) items.push(readItem(inner));
    this.pos = start + size;
    return items;
  }
}

// ---------- 送受信 ----------

export class CtrlCmdClient {
  constructor(
    readonly host: string,
    readonly port: number,
    /** 応答を待つ時間（データが届かない時間） */
    private readonly timeoutMs = 15000,
    /** 接続を待つ時間 */
    private readonly connectTimeoutMs = 5000
  ) {}

  /** コマンドを送り、結果のデータを返す。CMD_SUCCESS以外ならCtrlCmdErrorを投げる */
  send(command: number, payload: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;
      const socket = net.connect(this.port, this.host);
      const connectTimer = setTimeout(
        () => finish(new Error(`EDCB（${this.host}:${this.port}）にTCPで接続できません: 接続がタイムアウトしました`)),
        this.connectTimeoutMs
      );
      const finish = (err: Error | null, data?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        socket.destroy();
        if (err) reject(err);
        else resolve(data!);
      };
      const tryParse = (closed: boolean) => {
        const buf = Buffer.concat(chunks, received);
        if (buf.length >= 8 && buf.length >= 8 + buf.readUInt32LE(4)) {
          const code = buf.readUInt32LE(0);
          if (code !== CMD_SUCCESS) finish(new CtrlCmdError(command, code));
          else finish(null, buf.subarray(8, 8 + buf.readUInt32LE(4)));
        } else if (closed) {
          finish(new Error(`EDCB（${this.host}:${this.port}）が応答の途中で切断しました（コマンド${command}）`));
        }
      };
      socket.setTimeout(this.timeoutMs, () =>
        finish(new Error(`EDCB（${this.host}:${this.port}）からの応答がタイムアウトしました（コマンド${command}）`))
      );
      socket.on('connect', () => clearTimeout(connectTimer));
      socket.on('connect', () => socket.write(Buffer.concat([u32(command), u32(payload.length), payload])));
      socket.on('data', (d: Buffer) => {
        chunks.push(d);
        received += d.length;
        tryParse(false);
      });
      socket.on('end', () => tryParse(true));
      socket.on('close', () => tryParse(true));
      socket.on('error', (e: NodeJS.ErrnoException) =>
        finish(new Error(`EDCB（${this.host}:${this.port}）にTCPで接続できません: ${e.code ?? e.message}`))
      );
    });
  }

  /** 2000番台のコマンド: データの先頭にバージョンを付けて送り、結果のバージョンを読み飛ばしたReaderを返す */
  async sendVersioned(command: number, payload: Buffer = Buffer.alloc(0)): Promise<Reader> {
    const data = await this.send(command, Buffer.concat([u16(CMD_VER), payload]));
    const r = new Reader(data);
    if (data.length >= 2) r.u16();
    return r;
  }
}
