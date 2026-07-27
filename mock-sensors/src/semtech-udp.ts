// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Minimal Semtech UDP packet-forwarder client — just enough to push uplinks into
 * chirpstack-gateway-bridge on :1700, exactly like a real gateway.
 *
 * PUSH_DATA layout (protocol version 2):
 *   byte 0     : 0x02  (protocol version)
 *   bytes 1-2  : random token
 *   byte 3     : 0x00  (PUSH_DATA)
 *   bytes 4-11 : 8-byte gateway EUI
 *   bytes 12.. : UTF-8 JSON  {"rxpk":[{...}]}
 *
 * The bridge replies with PUSH_ACK; we don't need it. No PULL_DATA is required
 * for uplink-only injection (that only matters for receiving downlinks).
 */

import * as dgram from 'node:dgram';

const PROTOCOL_VERSION = 0x02;
const PUSH_DATA = 0x00;

export interface RxParams {
  /** Centre frequency in MHz. */
  freq: number;
  /** LoRa data rate, e.g. "SF10BW125". */
  datr: string;
  /** Coding rate, e.g. "4/5". */
  codr: string;
  /** IF channel index. */
  chan: number;
  /** Concentrator RF chain. */
  rfch: number;
}

/**
 * A valid DR0 uplink RF config for the given US915 sub-band. us915_0 uses the
 * 125 kHz channels at 902.3–903.7 MHz; us915_1 uses 903.9–905.3 MHz. Anything
 * else falls back to us915_0 (the stack default).
 */
export function rxParamsForRegion(region: string): RxParams {
  const base: Omit<RxParams, 'freq' | 'chan'> = { datr: 'SF10BW125', codr: '4/5', rfch: 0 };
  if (region === 'us915_1') return { ...base, freq: 903.9, chan: 8 };
  return { ...base, freq: 902.3, chan: 0 };
}

/** Build a PUSH_DATA datagram carrying one uplink frame. */
export function buildPushData(
  gatewayEui: string,
  phyPayload: Buffer,
  token: number,
  rx: RxParams,
): Buffer {
  const rxpk = {
    rxpk: [
      {
        tmst: Date.now() >>> 0, // uint32 µs-ish counter; only used for downlink timing
        chan: rx.chan,
        rfch: rx.rfch,
        freq: rx.freq,
        stat: 1, // CRC OK
        modu: 'LORA',
        datr: rx.datr,
        codr: rx.codr,
        rssi: -60,
        lsnr: 9.5,
        size: phyPayload.length,
        data: phyPayload.toString('base64'),
      },
    ],
  };
  const json = Buffer.from(JSON.stringify(rxpk), 'utf8');
  const header = Buffer.alloc(12);
  header[0] = PROTOCOL_VERSION;
  header.writeUInt16BE(token & 0xffff, 1);
  header[3] = PUSH_DATA;
  Buffer.from(gatewayEui, 'hex').copy(header, 4);
  return Buffer.concat([header, json]);
}

/** Send a datagram over an existing socket. */
export function sendDatagram(
  socket: dgram.Socket,
  host: string,
  port: number,
  packet: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(packet, port, host, (err) => (err ? reject(err) : resolve()));
  });
}
