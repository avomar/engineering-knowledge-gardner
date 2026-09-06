import { createRemoteJWKSet, jwtVerify } from "jose";

import type { Env } from "./env";

export interface AccessVerifier {
  verify(token: string, environment: Env): Promise<string>;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export class CloudflareAccessVerifier implements AccessVerifier {
  async verify(token: string, environment: Env): Promise<string> {
    const issuer = accessIssuer(environment.ACCESS_TEAM_DOMAIN);
    const audience = environment.ACCESS_AUD?.trim();
    if (issuer === null || !audience) {
      throw new AccessConfigurationError();
    }
    let keys = keySets.get(issuer);
    if (keys === undefined) {
      keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      keySets.set(issuer, keys);
    }
    const result = await jwtVerify(token, keys, { issuer, audience });
    if (typeof result.payload.sub !== "string" || result.payload.sub === "") {
      throw new Error("Access token has no subject.");
    }
    return result.payload.sub;
  }
}

export class AccessConfigurationError extends Error {
  override readonly name = "AccessConfigurationError";
}

export function accessConfigured(environment: Env): boolean {
  return (
    accessIssuer(environment.ACCESS_TEAM_DOMAIN) !== null &&
    Boolean(environment.ACCESS_AUD?.trim())
  );
}

function accessIssuer(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const candidate = value.includes("://") ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".cloudflareaccess.com") ||
      url.pathname !== "/"
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
