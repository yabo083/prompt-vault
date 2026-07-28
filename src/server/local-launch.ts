import { randomBytes, timingSafeEqual } from "node:crypto";

export interface LocalLaunchAuthorization {
  claim(input: { nonce: string; origin: string; instanceId: string }): "claimed" | "invalid" | "expired";
}

function equalText(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createLocalLaunchAuthorization({
  origin,
  instanceId,
  now = () => Date.now(),
  lifetimeMs = 60_000,
}: {
  origin: string;
  instanceId: string;
  now?: () => number;
  lifetimeMs?: number;
}) {
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = now() + lifetimeMs;
  let consumed = false;
  return {
    nonce,
    expiresAt,
    authorization: {
      claim(input) {
        if (now() > expiresAt) return "expired";
        if (consumed || input.origin !== origin || input.instanceId !== instanceId || !equalText(input.nonce, nonce)) return "invalid";
        consumed = true;
        return "claimed";
      },
    } satisfies LocalLaunchAuthorization,
  };
}
