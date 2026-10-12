import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IceConfiguration } from '@codetogether/contracts';

const urls = (prefix: string) =>
  z
    .string()
    .max(2000)
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(
          z
            .string()
            .max(256)
            .regex(new RegExp(`^${prefix}:[a-zA-Z0-9.\\-\\[\\]:]+(?:\\?transport=(?:udp|tcp))?$`)),
        )
        .max(6),
    );
export const iceEnvironmentSchema = z
  .object({
    STUN_URLS: urls('stuns?'),
    TURN_URLS: urls('turns?'),
    TURN_SHARED_SECRET: z.string().min(32).max(512).optional(),
    METERED_DOMAIN: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.metered\.live$/)
      .optional(),
    METERED_SECRET_KEY: z.string().min(16).max(512).optional(),
    TURN_TTL_SECONDS: z.coerce.number().int().min(300).max(3600).default(600),
    ICE_TRANSPORT_POLICY: z.enum(['all', 'relay']).default('all'),
  })
  .superRefine((v, ctx) => {
    if (
      !!v.METERED_DOMAIN !== !!v.METERED_SECRET_KEY ||
      (!!v.METERED_SECRET_KEY && !!v.TURN_SHARED_SECRET) ||
      (!!v.METERED_SECRET_KEY && v.TURN_TTL_SECONDS < 600) ||
      !!v.TURN_URLS.length !== !!(v.TURN_SHARED_SECRET || v.METERED_SECRET_KEY) ||
      (v.ICE_TRANSPORT_POLICY === 'relay' && !v.TURN_URLS.length)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Configure TURN URLs with either a coturn secret or Metered domain and secret; relay policy requires TURN.',
      });
  });
export type IceSettings = z.infer<typeof iceEnvironmentSchema>;
export function issueIce(settings: IceSettings): IceConfiguration {
  const expiry = Math.floor(Date.now() / 1000) + settings.TURN_TTL_SECONDS;
  const iceServers: IceConfiguration['iceServers'] = settings.STUN_URLS.length
    ? [{ urls: settings.STUN_URLS }]
    : [];
  if (settings.TURN_SHARED_SECRET) {
    // coturn TURN REST authentication. A random suffix avoids disclosing account identity.
    const username = `${expiry}:${randomUUID()}`;
    iceServers.push({
      urls: settings.TURN_URLS,
      username,
      credential: createHmac('sha1', settings.TURN_SHARED_SECRET).update(username).digest('base64'),
    });
  }
  return {
    iceServers,
    iceTransportPolicy: settings.ICE_TRANSPORT_POLICY,
    turnConfigured: !!settings.TURN_SHARED_SECRET,
    expiresAt: new Date(expiry * 1000).toISOString(),
  };
}
