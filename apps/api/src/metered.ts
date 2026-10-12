import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IceConfiguration } from '@codetogether/contracts';
import type { IceSettings } from './ice.js';

const credentialSchema = z.object({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(512),
  expiryInSeconds: z.number().int().min(300).max(3600),
});
type Prepared = { username: string; password: string; readyAt: number; expiresAt: number };
const unavailable = () =>
  new Error(
    'TURN credentials are warming up or unavailable. Wait two minutes, then try joining again.',
  );

/** Unassigned credentials only: each item is consumed once, never shared between HTTP responses. */
export class MeteredPool {
  private prepared: Prepared[] = [];
  private filling?: Promise<void>;
  private request?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private retryAt = 0;
  constructor(
    private settings: IceSettings,
    private transport: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}
  start() {
    if (this.timer || this.closed) return;
    void this.refill();
    this.timer = setInterval(() => void this.refill(), 30_000);
    this.timer.unref();
  }
  private prune() {
    // Leave enough lifetime for client refresh (60s early) plus ICE negotiation.
    this.prepared = this.prepared.filter((item) => item.expiresAt > this.now() + 180_000);
  }
  refill(): Promise<void> {
    if (this.closed || this.now() < this.retryAt) return Promise.resolve();
    if (this.filling) return this.filling;
    this.prune();
    this.filling = this.fill().finally(() => {
      this.filling = undefined;
    });
    return this.filling;
  }
  private async fill() {
    // One outbound request at a time. Prepare replacements early, keeping old
    // usable items during propagation: 16 future items, 32 total maximum.
    // Cap each refill too, even if calls consume items while filling.
    for (
      let count = 0;
      count < 16 &&
      this.prepared.length < 32 &&
      this.prepared.filter((item) => item.expiresAt > this.now() + 360_000).length < 16 &&
      !this.closed;
      count++
    ) {
      const controller = new AbortController();
      this.request = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      const startedAt = this.now();
      try {
        const url = new URL(`https://${this.settings.METERED_DOMAIN}/api/v1/turn/credential`);
        // Metered's documented API requires this query parameter. Never log URLs/errors.
        url.searchParams.set('secretKey', this.settings.METERED_SECRET_KEY!);
        const response = await this.transport(url, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expiryInSeconds: this.settings.TURN_TTL_SECONDS,
            label: `codetogether-${randomUUID()}`,
          }),
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw unavailable();
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 16_384) {
              await reader.cancel();
              throw unavailable();
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const value = credentialSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (value.expiryInSeconds > this.settings.TURN_TTL_SECONDS) throw unavailable();
        if (!this.closed)
          this.prepared.push({
            username: value.username,
            password: value.password,
            // Provider documents up to two minutes propagation after creation.
            readyAt: this.now() + 120_000,
            expiresAt: startedAt + value.expiryInSeconds * 1000,
          });
      } catch {
        // Includes invalid credentials, quota denial, malformed responses and timeouts.
        // Never retain provider error bodies or secrets in errors/logs.
        this.retryAt = this.now() + 30_000;
        return;
      } finally {
        clearTimeout(timeout);
        if (this.request === controller) this.request = undefined;
      }
    }
  }
  take(): IceConfiguration {
    if (this.closed) throw unavailable();
    this.prune();
    const index = this.prepared.findIndex((item) => item.readyAt <= this.now());
    if (index < 0) {
      void this.refill();
      throw unavailable();
    }
    const [item] = this.prepared.splice(index, 1);
    void this.refill();
    return {
      iceServers: [
        ...(this.settings.STUN_URLS.length ? [{ urls: this.settings.STUN_URLS }] : []),
        { urls: this.settings.TURN_URLS, username: item.username, credential: item.password },
      ],
      iceTransportPolicy: this.settings.ICE_TRANSPORT_POLICY,
      turnConfigured: true,
      expiresAt: new Date(item.expiresAt).toISOString(),
    };
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.request?.abort();
    this.prepared = [];
  }
}
