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
type Failure =
  'authentication' | 'rejected' | 'rate-limit' | 'provider' | 'response' | 'timeout' | 'network';
const failureMessages: Record<Failure, string> = {
  authentication:
    'TURN provider rejected authentication. The administrator must check the Metered domain and Developers secret in Render.',
  rejected:
    'TURN provider rejected credential creation. The administrator must check Metered plan access, quota and backend configuration.',
  'rate-limit':
    'TURN provider is rate limiting credential creation. Wait a minute before joining again.',
  provider:
    'TURN provider is temporarily unavailable. Try again shortly; contact the administrator if this persists.',
  response:
    'TURN provider returned an unsupported credential response. The administrator must check the backend TURN diagnostics.',
  timeout:
    'TURN credential requests are timing out. The administrator must check connectivity from Render to Metered.',
  network:
    'The backend cannot reach the TURN provider. The administrator must check connectivity from Render to Metered.',
};
export class MeteredUnavailableError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Unassigned credentials only: each item is consumed once, never shared between HTTP responses. */
export class MeteredPool {
  private prepared: Prepared[] = [];
  // Includes credentials already handed out: never revoke those while they may be in use.
  private owned = new Map<string, { expiresAt: number; assigned: boolean }>();
  private filling?: Promise<void>;
  private request?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private retryAt = 0;
  private failure?: Failure;
  constructor(
    private settings: IceSettings,
    private transport: typeof fetch = fetch,
    private now: () => number = Date.now,
    private report: (reason: Failure | 'recovered', status?: number) => void = (reason, status) =>
      console.warn(`[TURN] Metered ${reason}${status ? ` (HTTP ${status})` : ''}`),
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
    for (const [username, item] of this.owned)
      if (item.expiresAt <= this.now()) this.owned.delete(username);
    // Retire only this process's unassigned credentials. Leave two minutes for
    // replacement propagation before callers' existing credentials need renewal.
    const atCapacity = this.owned.size >= 8;
    const nextAssignedExpiry = Math.min(
      ...[...this.owned.values()].filter((item) => item.assigned).map((item) => item.expiresAt),
    );
    for (const [username, item] of this.owned) {
      if (this.closed) return;
      if (
        item.assigned ||
        (item.expiresAt > this.now() + 180_000 &&
          !(
            atCapacity &&
            nextAssignedExpiry > this.now() + 180_000 &&
            item.expiresAt <= this.now() + 360_000
          ))
      )
        continue;
      if (!(await this.retire(username))) return;
    }
    // One outbound request at a time. Prepare replacements early, keeping old
    // usable items during propagation: four future items, eight active total.
    // Metered's trial rejected the old sixteen-item pool at ten active credentials.
    // Cap each refill too, even if calls consume items while filling.
    for (
      let count = 0;
      count < 4 &&
      this.owned.size < 8 &&
      this.prepared.filter((item) => item.expiresAt > this.now() + 360_000).length < 4 &&
      !this.closed;
      count++
    ) {
      const controller = new AbortController();
      this.request = controller;
      // Background only: tolerate slower provider responses without delaying room actions.
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const startedAt = this.now();
      let reason: Failure = 'network';
      let httpStatus: number | undefined;
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
        httpStatus = response.status;
        if (!response.ok) {
          reason =
            response.status === 401
              ? 'authentication'
              : response.status === 429
                ? 'rate-limit'
                : response.status >= 500
                  ? 'provider'
                  : 'rejected';
          await response.body?.cancel();
          throw new Error();
        }
        reason = 'response';
        if (!response.body) throw new Error();
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
              throw new Error();
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const value = credentialSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (value.expiryInSeconds > this.settings.TURN_TTL_SECONDS) throw new Error();
        if (this.failure && !this.closed) this.report('recovered');
        this.failure = undefined;
        if (!this.closed) {
          this.owned.set(value.username, {
            // Use receipt time for conservative accounting of provider-active slots.
            expiresAt: this.now() + value.expiryInSeconds * 1000,
            assigned: false,
          });
          this.prepared.push({
            username: value.username,
            password: value.password,
            // Provider documents up to two minutes propagation after creation.
            readyAt: this.now() + 120_000,
            expiresAt: startedAt + value.expiryInSeconds * 1000,
          });
        }
      } catch {
        // Includes invalid credentials, quota denial, malformed responses and timeouts.
        // Never retain provider error bodies or secrets in errors/logs.
        if (this.closed) return;
        if (controller.signal.aborted) reason = 'timeout';
        // Only a fixed category and HTTP status: never URLs, bodies, credentials or exception text.
        if (this.failure !== reason) this.report(reason, httpStatus);
        this.failure = reason;
        this.retryAt = this.now() + 30_000;
        return;
      } finally {
        clearTimeout(timeout);
        if (this.request === controller) this.request = undefined;
      }
    }
  }
  private async retire(username: string): Promise<boolean> {
    // take() can run while DELETE awaits the provider. Remove eligibility first,
    // including on ambiguous deletion failure; never hand out a possibly revoked item.
    this.prepared = this.prepared.filter((item) => item.username !== username);
    const controller = new AbortController();
    this.request = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const url = new URL(`https://${this.settings.METERED_DOMAIN}/api/v1/turn/credential`);
      url.searchParams.set('secretKey', this.settings.METERED_SECRET_KEY!);
      const response = await this.transport(url, {
        method: 'DELETE',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) throw new Error();
      this.owned.delete(username);
      return true;
    } catch {
      if (!this.closed) {
        if (this.failure !== 'provider') this.report('provider');
        this.failure = 'provider';
        this.retryAt = this.now() + 30_000;
      }
      return false;
    } finally {
      clearTimeout(timeout);
      if (this.request === controller) this.request = undefined;
    }
  }
  take(): IceConfiguration {
    if (this.closed)
      throw new MeteredUnavailableError(
        'MEDIA_UNAVAILABLE',
        'TURN is unavailable. Try joining again shortly.',
      );
    this.prune();
    // Longest remaining lifetime reduces renewal churn under provider slot limits.
    const index = this.prepared.reduce(
      (best, item, i) =>
        item.readyAt <= this.now() && (best < 0 || item.expiresAt > this.prepared[best].expiresAt)
          ? i
          : best,
      -1,
    );
    if (index < 0) {
      void this.refill();
      const pending = this.prepared.filter((item) => item.readyAt > this.now());
      if (pending.length) {
        const seconds = Math.max(
          1,
          Math.ceil((Math.min(...pending.map((item) => item.readyAt)) - this.now()) / 1000),
        );
        throw new MeteredUnavailableError(
          'MEDIA_WARMING_UP',
          `TURN credentials are warming up. Try joining again in ${seconds} seconds.`,
        );
      }
      if (this.failure)
        throw new MeteredUnavailableError(
          'MEDIA_PROVIDER_UNAVAILABLE',
          failureMessages[this.failure],
        );
      throw new MeteredUnavailableError(
        'MEDIA_UNAVAILABLE',
        'TURN credentials are being prepared. Try joining again in two minutes. If this persists, ask the administrator to check backend TURN diagnostics.',
      );
    }
    const [item] = this.prepared.splice(index, 1);
    this.owned.get(item.username)!.assigned = true;
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
    this.owned.clear();
  }
}
