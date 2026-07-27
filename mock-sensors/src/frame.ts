// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * LoRaWAN frame construction.
 *
 * ChirpStack validates the message integrity code (MIC) before any frame-counter
 * check and drops frames that don't verify, so a mock must emit a real, correctly
 * signed and encrypted PHYPayload. `lora-packet` does both automatically: given a
 * NwkSKey it computes the AES-CMAC MIC over the frame (including FCnt), and given
 * the AppSKey it AES-encrypts the FRMPayload (for FPort > 0). LoRaWAN 1.0.x.
 *
 * OTAA joins are out of scope for now (ABP only); a `buildJoinRequest` would slot
 * in here for phase 2.
 */

import loraPacket from 'lora-packet';

export interface AbpSession {
  /** DevAddr as a hex string (8 chars). */
  devAddr: string;
  /** NwkSKey as a hex string (32 chars). */
  nwkSKey: string;
  /** AppSKey as a hex string (32 chars). */
  appSKey: string;
}

/**
 * Build an unconfirmed data-up PHYPayload for an ABP device.
 *
 * @returns the raw PHYPayload bytes (MIC computed, FRMPayload encrypted).
 */
export function buildUplink(
  session: AbpSession,
  fPort: number,
  payload: Buffer,
  fCnt: number,
): Buffer {
  const packet = loraPacket.fromFields(
    {
      MType: 'Unconfirmed Data Up',
      DevAddr: Buffer.from(session.devAddr, 'hex'),
      FCtrl: { ADR: false, ADRACKReq: false, ACK: false, FPending: false },
      FCnt: fCnt,
      FPort: fPort,
      payload,
    },
    Buffer.from(session.appSKey, 'hex'),
    Buffer.from(session.nwkSKey, 'hex'),
  );
  const phy = packet.getPHYPayload();
  if (!phy) throw new Error('lora-packet returned no PHYPayload');
  return phy;
}
