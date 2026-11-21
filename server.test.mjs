import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test("triage validates input and falls back when the model fails", async (t) => {
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverError = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => { serverError += chunk; });
  t.after(() => server.kill());

  let started = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(base);
      if (response.status === 200) {
        started = true;
        break;
      }
    } catch {
      // The server may still be starting.
    }
    await delay(50);
  }
  assert.ok(started, `Server did not start: ${serverError}`);

  async function triage(body) {
    const response = await fetch(`${base}/api/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return { status: response.status, body: await response.json() };
  }

  assert.deepEqual(await triage(JSON.stringify({ text: "Когда доставка?" })), {
    status: 200,
    body: {
      status: "ready",
      topic: "delivery",
      draft: "Спасибо за обращение. Уточним детали заявки.",
    },
  });
  for (const [text, topic] of [
    ["Какая цена?", "pricing"],
    ["Есть вопрос", "other"],
  ]) {
    const response = await triage(JSON.stringify({ text }));
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "ready");
    assert.equal(response.body.topic, topic);
    assert.ok(response.body.draft.trim());
  }

  for (const body of ["{", "{}", '{"text":null}', '{"text":42}', '{"text":"  "}']) {
    assert.deepEqual(await triage(body), {
      status: 400,
      body: { status: "invalid_input" },
    });
  }

  for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    const startedAt = Date.now();
    assert.deepEqual(await triage(JSON.stringify({ text: marker })), {
      status: 200,
      body: { status: "manual_review", topic: null, draft: null },
    }, marker);
    if (marker === "[timeout]") {
      assert.ok(Date.now() - startedAt < 800, "Model timeout exceeded the expected limit");
    }
  }
});
