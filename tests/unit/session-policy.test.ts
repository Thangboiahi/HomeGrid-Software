import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionCookieOptions, SESSION_DURATION_MS } from "@/services/auth/server-session";

test("HomeGrid session cookie is HttpOnly, same-site and expires after five days", () => {
  const original = process.env.NODE_ENV;
  Reflect.set(process.env, "NODE_ENV", "development");
  try {
    assert.deepEqual(sessionCookieOptions(), {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      maxAge: 5 * 24 * 60 * 60,
    });
    assert.equal(SESSION_DURATION_MS, 5 * 24 * 60 * 60 * 1000);
  } finally {
    if (original === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", original);
  }
});

test("HomeGrid session cookie is Secure in production", () => {
  const original = process.env.NODE_ENV;
  Reflect.set(process.env, "NODE_ENV", "production");
  try {
    assert.equal(sessionCookieOptions().secure, true);
  } finally {
    if (original === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", original);
  }
});
