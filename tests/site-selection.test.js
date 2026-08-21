import assert from "node:assert/strict";
import test from "node:test";

const storage = {};
let runtimeMessageHandler;
globalThis.chrome = {
  runtime: {
    async sendMessage(message) {
      return runtimeMessageHandler(message);
    }
  },
  storage: {
    local: {
      async get(key) {
        return { [key]: storage[key] };
      },
      async set(values) {
        Object.assign(storage, structuredClone(values));
      }
    }
  }
};

const { SITE_SELECTIONS_STORAGE_KEY } = await import("../src/constants.js");
const {
  getSiteOptions,
  loadSiteSelections,
  requestSiteSelection,
  setSiteSelection
} = await import("../src/site-selection.js");
const { KEEP_ALIVE_CONFIG } = await import("../src/config.js");
const {
  getEnabledTargets,
  getWebSocketTargets,
  normalizeWebSocketConfig
} = await import("../src/target-config.js");

runtimeMessageHandler = async (message) => {
  if (message.type !== "pagehelper.site-selection.set") {
    return { ok: false, error: "Unexpected message" };
  }

  await setSiteSelection(message.targetId, message.enabled);
  return { ok: true };
};

test("site options support all four independent selection combinations", async () => {
  for (const [first, second] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true]
  ]) {
    storage[SITE_SELECTIONS_STORAGE_KEY] = {
      "example-page": first,
      "second-page": second
    };
    await loadSiteSelections();

    assert.deepEqual(
      Object.fromEntries(getSiteOptions().map((option) => [option.id, option.enabled])),
      {
        "example-page": first,
        "second-page": second
      }
    );

    const expectedIds = [
      ...(first ? ["example-page"] : []),
      ...(second ? ["second-page"] : [])
    ];
    assert.deepEqual(getEnabledTargets().map((target) => target.id), expectedIds);
    assert.deepEqual(getWebSocketTargets().map((target) => target.id), expectedIds);
  }
});

test("changing one site preserves the other site selection", async () => {
  storage[SITE_SELECTIONS_STORAGE_KEY] = {
    "example-page": false,
    "second-page": true
  };
  await loadSiteSelections();
  await setSiteSelection("example-page", true);

  assert.deepEqual(storage[SITE_SELECTIONS_STORAGE_KEY], {
    "example-page": true,
    "second-page": true
  });
});

test("rapid updates to different sites are serialized without lost writes", async () => {
  storage[SITE_SELECTIONS_STORAGE_KEY] = {
    "example-page": false,
    "second-page": false
  };
  await loadSiteSelections();
  await Promise.all([
    setSiteSelection("example-page", true),
    setSiteSelection("second-page", true)
  ]);

  assert.deepEqual(storage[SITE_SELECTIONS_STORAGE_KEY], {
    "example-page": true,
    "second-page": true
  });
});

test("popup selection requests are persisted by the background message path", async () => {
  storage[SITE_SELECTIONS_STORAGE_KEY] = {
    "example-page": false,
    "second-page": false
  };
  await loadSiteSelections();
  await requestSiteSelection("second-page", true);

  assert.equal(storage[SITE_SELECTIONS_STORAGE_KEY]["example-page"], false);
  assert.equal(storage[SITE_SELECTIONS_STORAGE_KEY]["second-page"], true);
});

test("configured sites normalize to two and one CSRF token steps", () => {
  const [firstSite, secondSite] = KEEP_ALIVE_CONFIG.targets;
  assert.equal(normalizeWebSocketConfig(firstSite).csrfTokens.length, 2);
  assert.equal(normalizeWebSocketConfig(secondSite).csrfTokens.length, 1);
});

test("unknown site ids cannot be persisted", async () => {
  await assert.rejects(() => setSiteSelection("not-configured", true), /Unknown site option/);
});
