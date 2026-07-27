// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Turns a (sensor, vector) into a signed uplink and pushes it to the gateway
 * bridge. Holds one UDP socket and a per-device frame counter so a long-running
 * demo loop sends monotonically increasing FCnts (realistic), while the ABP
 * devices' `skipFcntCheck` still lets a fresh run start back at 0.
 */

import * as dgram from 'node:dgram';
import type { Config } from './config';
import { buildUplink } from './frame';
import {
  buildPushData,
  rxParamsForRegion,
  sendDatagram,
  type RxParams,
} from './semtech-udp';
import type { MockSensor, UplinkVector } from './sensors';

export class Emitter {
  private readonly socket = dgram.createSocket('udp4');
  private readonly fcnt = new Map<string, number>();
  private readonly rx: RxParams;
  private token = 0;

  constructor(private readonly cfg: Config) {
    this.rx = rxParamsForRegion(cfg.region);
  }

  /** Build + send one uplink for a sensor. Returns the FCnt used. */
  async emit(sensor: MockSensor, vector: UplinkVector): Promise<number> {
    const fCnt = this.fcnt.get(sensor.devEui) ?? 0;
    const phy = buildUplink(
      { devAddr: sensor.devAddr, nwkSKey: sensor.nwkSKey, appSKey: sensor.appSKey },
      vector.fPort,
      Buffer.from(vector.bytes),
      fCnt,
    );
    const packet = buildPushData(this.cfg.gatewayEui, phy, this.token++ & 0xffff, this.rx);
    await sendDatagram(this.socket, this.cfg.udpHost, this.cfg.udpPort, packet);
    this.fcnt.set(sensor.devEui, fCnt + 1);
    return fCnt;
  }

  close(): void {
    this.socket.close();
  }
}
