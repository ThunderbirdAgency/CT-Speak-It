import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, sign, createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
await db.exec(
  "create role anon; create role authenticated; create role service_role bypassrls;",
);
await db.exec(
  await readFile(
    new URL("../db/migrations/20260905_consumer.sql", import.meta.url),
    "utf8",
  ),
);
await db.exec(
  "create table mockingbird_events(user_id text,raw_text text); create table mockingbird_profiles(user_id text,profile jsonb);",
);
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
Object.assign(process.env, {
  SUPABASE_URL: "https://db.test",
  SUPABASE_SERVICE_ROLE_KEY: "local-test",
  CLERK_SECRET_KEY: "sk_test_local",
  CLERK_JWT_KEY: publicKey.export({ type: "spki", format: "pem" }),
  CLERK_AUTHORIZED_PARTIES: "https://bird.test",
  MOCKINGBIRD_PUBLIC_URL: "https://bird.test",
  MOCKINGBIRD_ADMIN_USER_IDS: "admin",
  ALLOWED_ORIGINS: "https://bird.test",
  ANTHROPIC_API_KEY: "local-test",
  GROQ_API_KEY: "local-test",
  STRIPE_SECRET_KEY: "sk_test_local",
  STRIPE_PRICE_ID: "price_pro",
  STRIPE_WEBHOOK_SECRET: "whsec_local",
});
function jwt(user, extra = {}) {
  const enc = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const text =
    enc({ alg: "RS256", typ: "JWT" }) +
    "." +
    enc({
      sub: user,
      sid: "sess_test",
      iss: "https://clerk.test",
      azp: "https://bird.test",
      iat: Math.floor(Date.now() / 1000),
      nbf: Math.floor(Date.now() / 1000) - 1,
      exp: Math.floor(Date.now() / 1000) + 600,
      ...extra,
    });
  return (
    text +
    "." +
    sign("RSA-SHA256", Buffer.from(text), privateKey).toString("base64url")
  );
}
let transcript = "um hello Jordan",
  modelText = "Hello Jordan.",
  modelStop = "end_turn",
  modelCalls = 0,
  voiceCalls = 0,
  stripeCalls = 0;
let subscriptions = [],
  checkoutSessions = [],
  stripeSub;
const requests = [];
function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
async function rest(url, init) {
  const table = url.pathname.split("/").at(-1);
  const method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  if (url.pathname.includes("/rpc/")) {
    const args = Object.values(body);
    const names = Object.keys(body);
    const result = await db.query(
      `select public.${table}(${names.map((x, i) => x + "=> $" + (i + 1)).join(",")}) as value`,
      args,
    );
    return response(result.rows[0].value);
  }
  assert.match(table, /^mockingbird_[a-z_]+$/);
  const args = [];
  const where = [];
  for (const [k, v] of url.searchParams) {
    if (["select", "order", "limit"].includes(k)) continue;
    assert.match(k, /^[a-z_]+$/);
    const dot = v.indexOf(".");
    const op = v.slice(0, dot),
      val = v.slice(dot + 1);
    if (op === "is" && val === "null") {
      where.push(k + " is null");
      continue;
    }
    const operators = { eq: "=", gt: ">", lte: "<=" };
    if (!operators[op]) throw new Error("Unsupported filter " + v);
    args.push(val);
    where.push(k + operators[op] + "$" + args.length);
  }
  const condition = where.length ? " where " + where.join(" and ") : "";
  if (method === "GET") {
    let projection = url.searchParams.get("select") || "*";
    assert.match(projection, /^[a-z_,*]+$/);
    const order = url.searchParams.get("order");
    const ordering = order ? " order by " + order.replace(".", " ") : "";
    assert.match(ordering, /^[a-z_ .]*$/);
    const limit = url.searchParams.get("limit");
    const sql = `select ${projection} from ${table}${condition}${ordering}${limit ? " limit " + Number(limit) : ""}`;
    return response((await db.query(sql, args)).rows);
  }
  if (method === "POST") {
    const keys = Object.keys(body);
    keys.forEach((k) => assert.match(k, /^[a-z_]+$/));
    const values = keys.map((k) =>
      typeof body[k] === "object" && body[k] !== null
        ? JSON.stringify(body[k])
        : body[k],
    );
    const ignore = init.headers.Prefer?.includes("ignore-duplicates")
      ? " on conflict do nothing"
      : "";
    await db.query(
      `insert into ${table}(${keys.join(",")}) values(${values.map((_, i) => "$" + (i + 1)).join(",")})${ignore}`,
      values,
    );
    return response(null, 201);
  }
  if (method === "PATCH") {
    const keys = Object.keys(body);
    if (!keys.length) return response(null);
    const start = args.length;
    args.push(
      ...keys.map((k) =>
        typeof body[k] === "object" && body[k] !== null
          ? JSON.stringify(body[k])
          : body[k],
      ),
    );
    await db.query(
      `update ${table} set ${keys.map((k, i) => k + "=$" + (start + i + 1)).join(",")}${condition}`,
      args,
    );
    return response(null);
  }
  if (method === "DELETE") {
    await db.query(`delete from ${table}${condition}`, args);
    return response(null);
  }
  throw new Error("Unexpected request");
}
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input));
  requests.push({ url: u.href, method: init.method || "GET", body: init.body });
  try {
    if (u.hostname === "db.test") return await rest(u, init);
    if (u.hostname === "api.groq.com") {
      voiceCalls++;
      return response({ text: transcript });
    }
    if (u.hostname === "api.anthropic.com") {
      modelCalls++;
      const sent = JSON.parse(init.body);
      const content = sent.tools
        ? [
            {
              type: "tool_use",
              id: "t1",
              name: "suggest",
              input: {
                writing_style: "Warm and concise.",
                vocabulary: ["escrow"],
                phrases: ["Happy to help."],
              },
            },
          ]
        : [{ type: "text", text: modelText }];
      return response({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "test-model",
        content,
        stop_reason: modelStop,
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    }
    if (u.hostname === "api.stripe.com") {
      stripeCalls++;
      if (u.pathname === "/v1/prices/price_pro")
        return response({
          id: "price_pro",
          active: true,
          type: "recurring",
          recurring: { interval: "month", interval_count: 1 },
          currency: "usd",
          unit_amount: 1500,
        });
      if (u.pathname === "/v1/customers")
        return response({
          id:
            "cus_" +
            new URLSearchParams(init.body).get("metadata[mockingbird_user]"),
        });
      if (u.pathname === "/v1/subscriptions")
        return response({
          object: "list",
          data: subscriptions,
          has_more: false,
        });
      if (u.pathname.startsWith("/v1/subscriptions/"))
        return response(stripeSub);
      if (u.pathname === "/v1/checkout/sessions" && init.method === "POST")
        return response({
          id: "cs_test",
          url: "https://checkout.stripe.com/test",
        });
      if (u.pathname === "/v1/checkout/sessions")
        return response({
          object: "list",
          data: checkoutSessions,
          has_more: false,
        });
      if (u.pathname === "/v1/billing_portal/sessions")
        return response({ url: "https://billing.stripe.com/test" });
    }
    throw new Error("Unexpected network host/route: " + u.href);
  } catch (err) {
    return response({ message: err.message }, 500);
  }
};
const { digest } = await import("../api/_lib/account.js");
const routes = {};
for (const name of [
  "account",
  "gifts",
  "device",
  "profile",
  "format",
  "transcribe",
  "rewrite",
  "actions",
  "act",
  "billing",
  "webhook",
  "public",
])
  routes[name] = (await import("../api/" + name + ".js")).default;
async function call(
  route,
  {
    method = "POST",
    user = "alice",
    token,
    body,
    query = {},
    audio,
    headers = {},
  } = {},
) {
  const req = {
    method,
    body,
    query,
    headers: {
      origin: "https://bird.test",
      ...(user ? { authorization: "Bearer " + (token || jwt(user)) } : {}),
      ...headers,
    },
  };
  if (audio)
    req[Symbol.asyncIterator] = async function* () {
      yield audio;
    };
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(n) {
      this.statusCode = n;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    end() {
      return this;
    },
  };
  await routes[route](req, res);
  return res;
}
let count = 0;
async function test(name, fn) {
  try {
    await fn();
    count++;
    console.log("✓ " + name);
  } catch (e) {
    console.error("✗ " + name);
    throw e;
  }
}
await test("migration is repeatable and all consumer tables deny public access", async () => {
  await db.exec(
    await readFile(
      new URL("../db/migrations/20260905_consumer.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.exec("set role anon");
  await assert.rejects(
    db.query("select * from mockingbird_accounts"),
    /permission denied/,
  );
  await assert.rejects(
    db.query("select mockingbird_redeem('alice','x')"),
    /permission denied/,
  );
  await db.exec("reset role");
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from pg_class where relname in ('mockingbird_accounts','mockingbird_devices','mockingbird_gift_codes','mockingbird_redemptions','mockingbird_pairings','mockingbird_quotas') and relrowsecurity",
      )
    ).rows[0].n,
    6,
  );
});
await test("anonymous, expired and wrong-origin credentials cannot reach paid APIs", async () => {
  const before = voiceCalls;
  assert.equal(
    (await call("transcribe", { user: null, audio: Buffer.alloc(500) }))
      .statusCode,
    401,
  );
  assert.equal(
    (await call("account", { method: "GET", token: jwt("alice", { exp: 1 }) }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await call("account", {
        method: "GET",
        token: jwt("alice", { azp: "https://evil.test" }),
      })
    ).statusCode,
    401,
  );
  assert.equal(voiceCalls, before);
});
await test("new accounts default to no memory and no paid access", async () => {
  const r = await call("account", { method: "GET" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.memory_enabled, false);
  assert.equal(r.body.access.active, false);
  assert.equal(
    (await call("transcribe", { audio: Buffer.alloc(500) })).statusCode,
    402,
  );
});
await test("verified identity ignores a forged user in query and request body", async () => {
  await call("account", {
    method: "PATCH",
    user: "bob",
    body: { profile: { writing_style: "Bob only" }, memory_enabled: true },
  });
  await call("account", {
    method: "PATCH",
    body: { user: "bob", profile: { writing_style: "Alice only" } },
  });
  const r = await call("account", { method: "GET", query: { user: "bob" } });
  assert.equal(r.body.profile.writing_style, "Alice only");
  assert.equal(
    (await call("account", { method: "GET", user: "bob" })).body.profile
      .writing_style,
    "Bob only",
  );
});
let giftCode, connectionCode, deviceToken;
await test("gift issuance is admin-only and code is stored only as a hash", async () => {
  assert.equal(
    (await call("gifts", { body: { label: "Nope" } })).statusCode,
    403,
  );
  const r = await call("gifts", {
    user: "admin",
    body: { label: "Pilot", days: 365, uses: 1 },
  });
  assert.equal(r.statusCode, 201);
  giftCode = r.body.code;
  const saved = (await db.query("select * from mockingbird_gift_codes"))
    .rows[0];
  assert.equal(saved.code_hash, digest(giftCode));
  assert.ok(!JSON.stringify(saved).includes(giftCode));
});
await test("gift redemption is idempotent, grants Pro and enforces recipient limit", async () => {
  const first = await call("gifts", {
    body: { action: "redeem", code: giftCode },
  });
  assert.equal(first.statusCode, 200);
  const repeat = await call("gifts", {
    body: { action: "redeem", code: giftCode },
  });
  assert.equal(repeat.body.giftUntil, first.body.giftUntil);
  assert.equal(
    (
      await call("gifts", {
        user: "bob",
        body: { action: "redeem", code: giftCode },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await call("account", { method: "GET" })).body.access.source,
    "gift",
  );
  assert.equal(
    (await db.query("select uses from mockingbird_gift_codes")).rows[0].uses,
    1,
  );
});
await test("revoked and expired gift codes cannot grant access", async () => {
  const r = await call("gifts", { user: "admin", body: { days: 30, uses: 2 } });
  await db.query(
    "update mockingbird_gift_codes set revoked_at=now() where code_hash=$1",
    [digest(r.body.code)],
  );
  assert.equal(
    (
      await call("gifts", {
        user: "bob",
        body: { action: "redeem", code: r.body.code },
      })
    ).statusCode,
    400,
  );
});
await test("single-use device pairing creates a revocable session without revealing stored tokens", async () => {
  const p = await call("device", { body: {} });
  assert.equal(p.statusCode, 201);
  connectionCode = p.body.code;
  const r = await call("device", {
    user: null,
    body: { action: "exchange", code: connectionCode, name: "Test Mac" },
  });
  assert.equal(r.statusCode, 200);
  deviceToken = r.body.token;
  assert.equal(
    (
      await call("device", {
        user: null,
        body: { action: "exchange", code: connectionCode },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await call("transcribe", { token: deviceToken, audio: Buffer.alloc(500) }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await call("gifts", {
        token: deviceToken,
        body: { action: "redeem", code: giftCode },
      })
    ).statusCode,
    403,
  );
  const list = (await call("account", { method: "GET" })).body.devices;
  assert.ok(!JSON.stringify(list).includes(deviceToken));
  await call("device", {
    user: "bob",
    method: "DELETE",
    body: { id: r.body.deviceId },
  });
  assert.equal(
    (await call("transcribe", { token: deviceToken, audio: Buffer.alloc(500) }))
      .statusCode,
    200,
  );
  await call("device", { method: "DELETE", body: { id: r.body.deviceId } });
  assert.equal(
    (await call("transcribe", { token: deviceToken, audio: Buffer.alloc(500) }))
      .statusCode,
    401,
  );
});
await test("dictation cleans words but never archives transcripts, even with memory enabled", async () => {
  await call("account", { method: "PATCH", body: { memory_enabled: true } });
  const r = await call("format", {
    body: { text: "private client words", learn: true, user: "bob" },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.text, "Hello Jordan.");
  assert.equal(
    (await db.query("select count(*)::int as n from mockingbird_events"))
      .rows[0].n,
    0,
  );
  const sent = JSON.parse(
    requests.filter((x) => x.url.includes("anthropic")).at(-1).body,
  );
  assert.match(sent.messages[0].content, /Alice only/);
  assert.doesNotMatch(sent.messages[0].content, /Bob only/);
});
await test("disabling memory removes it from formatting context", async () => {
  await call("account", { method: "PATCH", body: { memory_enabled: false } });
  await call("format", { body: { text: "hello", learn: true } });
  assert.doesNotMatch(
    JSON.parse(requests.filter((x) => x.url.includes("anthropic")).at(-1).body)
      .messages[0].content,
    /Alice only/,
  );
});
await test("memory suggestions are returned for review and not persisted", async () => {
  const r = await call("profile", {
    body: {
      sample: "Thank you for coming by. Happy to help with your next steps.",
    },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.saved, false);
  assert.equal(r.body.suggestion.writing_style, "Warm and concise.");
  assert.equal(
    (await call("account", { method: "GET" })).body.profile.writing_style,
    "Alice only",
  );
});
await test("saved responses require explicit insert phrase and remain exact", async () => {
  await call("account", {
    method: "PATCH",
    body: {
      snippets: [{ trigger: "follow-up", text: "Thanks for coming by." }],
    },
  });
  transcript = "Insert follow-up.";
  let r = await call("transcribe", { audio: Buffer.alloc(500) });
  assert.equal(r.body.snippet, "Thanks for coming by.");
  transcript = "follow-up";
  r = await call("transcribe", { audio: Buffer.alloc(500) });
  assert.equal(r.body.snippet, null);
});
await test("quota exhaustion prevents upstream calls", async () => {
  await db.query(
    "insert into mockingbird_quotas(user_id,bucket,used) values('alice','voice',240) on conflict(user_id,bucket,day) do update set used=240",
  );
  const before = voiceCalls;
  assert.equal(
    (await call("transcribe", { audio: Buffer.alloc(500) })).statusCode,
    429,
  );
  assert.equal(voiceCalls, before);
  await db.query("delete from mockingbird_quotas where bucket='voice'");
});
await test("oversized audio is rejected while streaming and truncated cleanup preserves original", async () => {
  assert.equal(
    (await call("transcribe", { audio: Buffer.alloc(4 * 1024 * 1024 + 1) }))
      .statusCode,
    413,
  );
  modelStop = "max_tokens";
  assert.equal(
    (await call("format", { body: { text: "Keep all these words." } })).body
      .text,
    "Keep all these words.",
  );
  assert.equal(
    (
      await call("rewrite", {
        body: { text: "Original", instruction: "Shorter" },
      })
    ).statusCode,
    422,
  );
  modelStop = "end_turn";
});
await test("CRM actions remain unavailable to authenticated users", async () => {
  assert.equal(
    (await call("actions", { body: { text: "Delete all contacts" } }))
      .statusCode,
    501,
  );
  assert.equal(
    (await call("act", { body: { actions: [{ name: "delete", input: {} }] } }))
      .statusCode,
    501,
  );
});
await test("erasure clears legacy text, preferences and snippets only for the verified account", async () => {
  await db.exec(
    "insert into mockingbird_events values ('alice','legacy'),('bob','keep'); insert into mockingbird_profiles values ('alice','{}'),('bob','{}');",
  );
  assert.equal(
    (await call("account", { method: "DELETE", query: { user: "bob" } }))
      .statusCode,
    200,
  );
  const a = (await call("account", { method: "GET" })).body;
  assert.deepEqual(a.profile, {});
  assert.deepEqual(a.snippets, []);
  assert.equal(a.memory_enabled, false);
  assert.deepEqual(
    (await db.query("select user_id from mockingbird_events")).rows,
    [{ user_id: "bob" }],
  );
});
await test("checkout never charges a gifted account and uses server-owned price/customer", async () => {
  assert.equal(
    (
      await call("billing", {
        body: { action: "checkout", priceId: "evil", customerId: "victim" },
      })
    ).statusCode,
    409,
  );
  const r = await call("billing", {
    user: "bob",
    body: { action: "checkout", priceId: "evil", customerId: "victim" },
  });
  assert.equal(r.statusCode, 200);
  const sent = requests
    .filter((x) => x.url.endsWith("/checkout/sessions") && x.method === "POST")
    .at(-1);
  assert.ok(sent);
  assert.match(String(sent.body), /price_pro/);
  assert.doesNotMatch(String(sent.body), /evil|victim/);
});
await test("billing portal binds to the authenticated account", async () => {
  const r = await call("billing", {
    user: "bob",
    body: { action: "portal", customerId: "victim" },
  });
  assert.equal(r.statusCode, 200);
  assert.doesNotMatch(
    String(
      requests.filter((x) => x.url.endsWith("/billing_portal/sessions")).at(-1)
        .body,
    ),
    /victim/,
  );
});
await test("webhooks require valid signature and safely handle duplicate/out-of-order events", async () => {
  const now = Math.floor(Date.now() / 1000);
  stripeSub = {
    id: "sub_test",
    customer: "cus_bob",
    metadata: { mockingbird_user: "bob" },
    status: "active",
    items: {
      data: [{ price: { id: "price_pro" }, current_period_end: now + 86400 }],
    },
  };
  const invoke = async (created, signature = true) => {
    const raw = Buffer.from(
      JSON.stringify({
        id: "evt_" + created,
        created,
        type: "customer.subscription.updated",
        data: { object: { id: "sub_test" } },
      }),
    );
    const h = createHmac("sha256", "whsec_local")
      .update(now + "." + raw.toString())
      .digest("hex");
    return call("webhook", {
      user: null,
      audio: raw,
      headers: { "stripe-signature": signature ? `t=${now},v1=${h}` : "bad" },
    });
  };
  assert.equal((await invoke(now, false)).statusCode, 400);
  assert.equal((await invoke(now)).statusCode, 200);
  assert.equal((await invoke(now)).statusCode, 200);
  assert.equal(
    (await call("account", { user: "bob", method: "GET" })).body.access.source,
    "subscription",
  );
  stripeSub.status = "canceled";
  await invoke(now + 10);
  stripeSub.status = "active";
  await invoke(now - 10);
  assert.equal(
    (await call("account", { user: "bob", method: "GET" })).body.access.active,
    false,
  );
});
console.log(`\n${count} consumer integration checks passed.`);
await db.close();
