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

/**
 * The US915 125 kHz uplink data rates (RP002-1.0.3 regional parameters), with the
 * maximum *application* payload each can carry.
 *
 * The limit matters because it is physical, not advisory: a frame longer than the
 * DR allows cannot be modulated into the air at that spreading factor, and even
 * where it nominally fits, a 41-byte frame at SF10BW125 is ~600 ms time-on-air —
 * well past the FCC 400 ms dwell-time limit for US915 125 kHz channels. No real
 * gateway would ever emit one. ChirpStack does not police this, so an oversized
 * frame is happily stored with `event_up.dr = 0`, which then poisons every
 * downstream link-budget, airtime and duty-cycle calculation. We therefore pick
 * the DR from the payload rather than pinning one.
 *
 * DR4 (SF8BW500) is deliberately absent: it lives on the 500 kHz channels 64–71
 * at their own frequencies, which would mean a second channel plan for no gain.
 */
export interface Us915DataRate {
  /** US915 uplink DR index, as ChirpStack records it in `event_up.dr`. */
  dr: number;
  /** Packet-forwarder data-rate string, e.g. "SF7BW125". */
  datr: string;
  /** Maximum application (FRMPayload) bytes this DR can carry. */
  maxPayload: number;
}

export const US915_UPLINK_DATA_RATES: readonly Us915DataRate[] = [
  { dr: 0, datr: 'SF10BW125', maxPayload: 11 },
  { dr: 1, datr: 'SF9BW125', maxPayload: 53 },
  { dr: 2, datr: 'SF8BW125', maxPayload: 125 },
  { dr: 3, datr: 'SF7BW125', maxPayload: 242 },
];

/** Largest application payload any 125 kHz US915 uplink DR can carry. */
const MAX_APP_PAYLOAD = US915_UPLINK_DATA_RATES[US915_UPLINK_DATA_RATES.length - 1].maxPayload;

/** 125 kHz channels per US915 sub-band, and the spacing between them. */
const CHANNELS_PER_SUB_BAND = 8;
const CHANNEL_SPACING_MHZ = 0.2;

interface SubBandPlan {
  /** Index of the sub-band's first 125 kHz channel. */
  firstChan: number;
  /** Centre frequency of that first channel, in MHz. */
  firstFreqMhz: number;
}

/**
 * The two US915 sub-bands this harness knows how to transmit on: us915_0 is
 * channels 0–7 at 902.3–903.7 MHz, us915_1 is channels 8–15 at 903.9–905.3 MHz.
 * Membership here is also the region whitelist — see `subBandPlan`.
 */
const SUB_BAND_PLANS = new Map<string, SubBandPlan>([
  ['us915_0', { firstChan: 0, firstFreqMhz: 902.3 }],
  ['us915_1', { firstChan: 8, firstFreqMhz: 903.9 }],
]);

export interface RxParams {
  /** Centre frequency in MHz, as the rxpk `freq` field carries it. */
  freq: number;
  /** LoRa data rate, e.g. "SF10BW125". */
  datr: string;
  /** US915 uplink DR index matching `datr` — what ChirpStack stores as `dr`. */
  dr: number;
  /** Coding rate, e.g. "4/5". */
  codr: string;
  /** IF channel index. */
  chan: number;
  /** Concentrator RF chain. */
  rfch: number;
}

/**
 * Reject any region this harness cannot legally transmit on.
 *
 * The old code silently fell back to the us915_0 channel plan for *anything* that
 * was not us915_1, and docker-compose.yml openly invites setting REGION. With
 * REGION=eu868 the harness would have kept transmitting at 902.3 MHz into a stack
 * with no such channel: every frame dropped at the network server, every emitter
 * log line still reading like a success, and nothing ever reaching the event
 * store. Failing loudly at startup is the only honest option — this is the single
 * region check in the harness, and provisioning's hardcoded `region: 'US915'`
 * relies on it.
 */
function subBandPlan(region: string): SubBandPlan {
  const plan = SUB_BAND_PLANS.get(region);
  if (!plan) {
    throw new Error(
      `unsupported REGION "${region}": the mock-sensor harness is US915-only — ` +
        `set REGION to one of ${[...SUB_BAND_PLANS.keys()].join(', ')}`,
    );
  }
  return plan;
}

/** Throws unless `region` is a US915 sub-band this harness can transmit on. */
export function assertSupportedRegion(region: string): void {
  subBandPlan(region);
}

/** Coerce a spread index to a non-negative integer so `%` can't go negative. */
function normalizeIndex(spreadIndex: number): number {
  return Math.abs(Math.trunc(spreadIndex)) || 0;
}

/**
 * Choose a data rate that can actually carry `payloadLen` application bytes.
 *
 * Every DR whose limit clears the payload is a legal choice, so we take that
 * candidate set and index into it with `spreadIndex` (the sensor's 1-based
 * index). The result is deterministic — the same sensor always sends the same
 * vector at the same DR, which keeps assertions stable — while still spreading
 * the fleet across several DRs so the bench exercises more than one link budget.
 * Deriving the set from the payload rather than hardcoding a per-sensor DR means
 * a sensor added later with a larger payload stays legal for free.
 */
export function selectDr(payloadLen: number, spreadIndex: number): Us915DataRate {
  if (payloadLen > MAX_APP_PAYLOAD) {
    throw new Error(
      `application payload of ${payloadLen} bytes exceeds the ${MAX_APP_PAYLOAD}-byte ` +
        `maximum for US915 125 kHz uplinks (DR3/SF7BW125) — no legal data rate can carry it`,
    );
  }
  const candidates = US915_UPLINK_DATA_RATES.filter((c) => c.maxPayload >= payloadLen);
  // `candidates` is never empty: the guard above bounds payloadLen by DR3's limit.
  return candidates[normalizeIndex(spreadIndex) % candidates.length];
}

/**
 * A legal uplink RF config for one frame on the given US915 sub-band.
 *
 * This harness is US915-only: `region` must be one of us915_0 / us915_1, and any
 * other value throws (see `subBandPlan`) rather than silently borrowing the
 * us915_0 channel plan.
 *
 * The data rate comes from the application payload length (see `selectDr`); the
 * channel comes from the sensor index, so the fleet spreads over all eight 125 kHz
 * channels of the sub-band instead of piling every frame onto channel 0 as before
 * — a single-channel bench never exercises the multi-channel path at all.
 *
 * @param region      the configured sub-band; anything but us915_0/us915_1 throws.
 * @param payloadLen  application (FRMPayload) bytes — NOT the assembled PHYPayload,
 *                    since the DR limits are stated against the application payload.
 * @param spreadIndex the sensor's 1-based index, used to spread DR and channel.
 */
export function rxParamsForRegion(
  region: string,
  payloadLen: number,
  spreadIndex: number,
): RxParams {
  const plan = subBandPlan(region);
  const index = normalizeIndex(spreadIndex);
  const rate = selectDr(payloadLen, index);
  // Sensor indices are 1-based, channel offsets are 0-based.
  const offset = (index + CHANNELS_PER_SUB_BAND - 1) % CHANNELS_PER_SUB_BAND;
  const chan = plan.firstChan + offset;
  // 200 kHz steps accumulate binary-float error (902.3 + 0.2*3 = 902.8999...),
  // and the rxpk `freq` field is matched against ChirpStack's channel plan, so
  // snap to the one decimal place the plan is actually specified at.
  const freq = Number((plan.firstFreqMhz + CHANNEL_SPACING_MHZ * offset).toFixed(1));
  return { freq, datr: rate.datr, dr: rate.dr, codr: '4/5', chan, rfch: 0 };
}

/** The rxpk `freq` (MHz) as the integer Hz ChirpStack reports in `txInfo.frequency`. */
export function freqMhzToHz(freqMhz: number): number {
  return Math.round(freqMhz * 1_000_000);
}

/** A gateway EUI as the header wants it: exactly 8 bytes, i.e. 16 hex chars. */
const GATEWAY_EUI_HEX = /^[0-9a-fA-F]{16}$/;

/** Build a PUSH_DATA datagram carrying one uplink frame. */
export function buildPushData(
  gatewayEui: string,
  phyPayload: Buffer,
  token: number,
  rx: RxParams,
): Buffer {
  // The EUI occupies a fixed 8-byte slot in a zero-filled header, so a short or
  // non-hex string does not fail — `Buffer.from(x, 'hex')` just yields fewer
  // bytes and the remainder stays 0x00. The frame then goes out under a gateway
  // that isn't registered, ChirpStack drops it, and nothing anywhere reports an
  // error. loadConfig() screens the env var; this covers direct callers (tests).
  if (!GATEWAY_EUI_HEX.test(gatewayEui)) {
    throw new Error(
      `invalid gateway EUI "${gatewayEui}": expected exactly 16 hex characters (8 bytes)`,
    );
  }
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
