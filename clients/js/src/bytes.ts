/**
 * Byte reading helpers for manual account deserialization.
 * All multi-byte integers are little-endian unless noted.
 */

import { type Address, getAddressDecoder } from "@solana/kit";

const addressDecoder = getAddressDecoder();

export class ByteReader {
  private view: DataView;
  private bytes: Uint8Array;
  private offset = 0;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get position(): number {
    return this.offset;
  }

  seek(offset: number): void {
    if (offset < 0 || offset > this.bytes.length) {
      throw new RangeError(`seek out of range: ${offset}`);
    }
    this.offset = offset;
  }

  u8(at?: number): number {
    const o = at ?? this.offset;
    const v = this.view.getUint8(o);
    if (at === undefined) this.offset += 1;
    return v;
  }

  bool(at?: number): boolean {
    return this.u8(at) !== 0;
  }

  u16(at?: number): number {
    const o = at ?? this.offset;
    const v = this.view.getUint16(o, true);
    if (at === undefined) this.offset += 2;
    return v;
  }

  u64(at?: number): bigint {
    const o = at ?? this.offset;
    const v = this.view.getBigUint64(o, true);
    if (at === undefined) this.offset += 8;
    return v;
  }

  pubkey(at?: number): Address {
    const o = at ?? this.offset;
    const slice = this.bytes.subarray(o, o + 32);
    if (at === undefined) this.offset += 32;
    return addressDecoder.decode(slice);
  }

  bytes32(at?: number): Uint8Array {
    const o = at ?? this.offset;
    if (o + 32 > this.bytes.length) {
      throw new RangeError(
        `bytes32 read out of bounds: offset=${o} bufferSize=${this.bytes.length}`,
      );
    }
    if (at === undefined) this.offset += 32;
    return this.bytes.slice(o, o + 32);
  }

  raw(length: number, at?: number): Uint8Array {
    const o = at ?? this.offset;
    if (o + length > this.bytes.length) {
      throw new RangeError(
        `raw read out of bounds: offset=${o} length=${length} bufferSize=${this.bytes.length}`,
      );
    }
    if (at === undefined) this.offset += length;
    return this.bytes.slice(o, o + length);
  }
}

/** Encode a u64 as 8 little-endian bytes. */
export function u64Le(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return buf;
}

/** Encode a u16 as 2 little-endian bytes. */
export function u16Le(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value, true);
  return buf;
}

/**
 * Validate that a numeric value falls within an enum's expected range.
 * Use after `r.u8()` when the byte should map to a known enum variant —
 * catches on-chain data corruption or version skew before downstream code
 * hits an unexpected default branch in a switch.
 *
 * @param value The raw u8 read from the buffer
 * @param max Highest valid enum value (inclusive)
 * @param name Enum name for error messages
 */
export function checkEnum<T extends number>(
  value: number,
  max: number,
  name: string,
): T {
  if (value > max) {
    throw new RangeError(
      `Invalid ${name}: ${value} (expected 0..=${max})`,
    );
  }
  return value as T;
}

/** Concatenate Uint8Arrays into a single buffer. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
