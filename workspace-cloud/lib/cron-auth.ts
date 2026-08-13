//! Constant-time bearer authentication shared by every internal cron route.

import "server-only";

import { timingSafeEqual } from "node:crypto";

import { env } from "./env";

export function cronRequestAuthorized(request: Request) {
  const secret = env.cronSecret();
  if (!secret || secret.length < 16) return false;
  const actual = Buffer.from(request.headers.get("authorization") ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
