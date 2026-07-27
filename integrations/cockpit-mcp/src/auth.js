import { timingSafeEqual } from "node:crypto";

function constantTimeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function hasValidBearer(authorization, expectedToken) {
  if (typeof authorization !== "string") return false;
  const match = /^Bearer ([\x21-\x7e]+)$/.exec(authorization);
  if (!match) return false;
  return constantTimeEqual(match[1], expectedToken);
}

export function bearerAuth(expectedToken) {
  return (req, res, next) => {
    if (hasValidBearer(req.headers.authorization, expectedToken)) {
      next();
      return;
    }
    res.setHeader(
      "WWW-Authenticate",
      'Bearer realm="cockpit-mcp", error="invalid_token"',
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(401).json({ error: "unauthorized" });
  };
}
