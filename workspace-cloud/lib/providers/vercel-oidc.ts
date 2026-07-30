// Vercel injects this token into Functions, but the request header is still an
// external boundary. Bootstrap mutations use claims only after RS256/JWKS
// verification against the token's exact team or global issuer.
import "server-only";

import { createPublicKey, verify } from "node:crypto";
import { ProviderRequestError } from "./provider-types";

type JsonObject = Record<string, unknown>;

export type VerifiedVercelOidc = {
  issuer: string;
  audience: string;
  subject: string;
  owner: string;
  project: string;
  projectId: string;
  environment: "production";
};

function decodeJson(segment: string): JsonObject {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length > 16_384) {
    throw new Error("invalid JWT segment");
  }
  const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid JWT object");
  }
  return value as JsonObject;
}

function requiredClaim(
  claims: JsonObject,
  key: string,
  pattern: RegExp,
  max = 256,
) {
  const value = claims[key];
  if (typeof value !== "string" || value.length > max || !pattern.test(value)) {
    throw new Error(`invalid ${key}`);
  }
  return value;
}

async function publicKey(issuer: string, kid: string) {
  const discoveryUrl = new URL("/.well-known/openid-configuration", `${issuer}/`);
  const discoveryResponse = await fetch(discoveryUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const discovery = await discoveryResponse.json().catch(() => null) as JsonObject | null;
  if (
    !discoveryResponse.ok
    || !discovery
    || discovery.issuer !== issuer
    || typeof discovery.jwks_uri !== "string"
  ) {
    throw new Error("invalid Vercel OIDC discovery");
  }
  const jwksUrl = new URL(discovery.jwks_uri);
  if (
    jwksUrl.protocol !== "https:"
    || jwksUrl.hostname !== "oidc.vercel.com"
  ) {
    throw new Error("invalid Vercel JWKS origin");
  }
  const jwksResponse = await fetch(jwksUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const jwks = await jwksResponse.json().catch(() => null) as JsonObject | null;
  const keys = jwks && Array.isArray(jwks.keys) ? jwks.keys : [];
  const key = keys.find((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as JsonObject;
    return row.kid === kid
      && row.kty === "RSA"
      && row.alg === "RS256"
      && (row.use === undefined || row.use === "sig");
  });
  if (!jwksResponse.ok || !key) throw new Error("Vercel signing key was not found");
  return createPublicKey({ key: key as JsonWebKey, format: "jwk" });
}

export async function verifyVercelOidcToken(
  token: string,
): Promise<VerifiedVercelOidc> {
  try {
    if (
      token.length < 100
      || token.length > 32 * 1_024
      || /\s/.test(token)
    ) {
      throw new Error("invalid token");
    }
    const segments = token.split(".");
    if (segments.length !== 3) throw new Error("invalid JWT");
    const [encodedHeader, encodedClaims, encodedSignature] = segments;
    const header = decodeJson(encodedHeader);
    const claims = decodeJson(encodedClaims);
    const kid = requiredClaim(header, "kid", /^[A-Za-z0-9._-]{1,200}$/);
    if (
      header.alg !== "RS256"
      || (
        header.typ !== undefined
        && header.typ !== "JWT"
        && header.typ !== "jwt"
      )
    ) {
      throw new Error("invalid JWT algorithm");
    }
    const issuer = requiredClaim(
      claims,
      "iss",
      /^https:\/\/oidc\.vercel\.com(?:\/[A-Za-z0-9_-]{1,100})?$/,
    );
    const owner = requiredClaim(claims, "owner", /^[A-Za-z0-9_-]{1,100}$/);
    const project = requiredClaim(claims, "project", /^[A-Za-z0-9_-]{1,100}$/);
    const projectId = requiredClaim(claims, "project_id", /^prj_[A-Za-z0-9]{8,100}$/);
    const audience = requiredClaim(
      claims,
      "aud",
      /^https:\/\/vercel\.com\/[A-Za-z0-9_-]{1,100}$/,
    );
    const subject = requiredClaim(
      claims,
      "sub",
      /^owner:[A-Za-z0-9_-]{1,100}:project:[A-Za-z0-9_-]{1,100}:environment:production$/,
      360,
    );
    if (
      claims.environment !== "production"
      || audience !== `https://vercel.com/${owner}`
      || subject !== `owner:${owner}:project:${project}:environment:production`
    ) {
      throw new Error("unexpected Vercel deployment identity");
    }
    const now = Math.floor(Date.now() / 1_000);
    const issuedAt = claims.iat;
    const notBefore = claims.nbf;
    const expiresAt = claims.exp;
    if (
      typeof issuedAt !== "number"
      || typeof notBefore !== "number"
      || typeof expiresAt !== "number"
      || issuedAt > now + 60
      || notBefore > now + 60
      || expiresAt <= now + 30
      || expiresAt > now + 3_700
    ) {
      throw new Error("invalid Vercel token lifetime");
    }
    const key = await publicKey(issuer, kid);
    const signature = Buffer.from(encodedSignature, "base64url");
    if (
      signature.length < 128
      || !verify(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        key,
        signature,
      )
    ) {
      throw new Error("invalid Vercel token signature");
    }
    return {
      issuer,
      audience,
      subject,
      owner,
      project,
      projectId,
      environment: "production",
    };
  } catch {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "The production Vercel deployment identity could not be verified",
      503,
    );
  }
}
