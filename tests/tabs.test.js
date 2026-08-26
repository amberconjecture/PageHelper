import assert from "node:assert/strict";
import test from "node:test";

const queryResults = [];
let createCalls = 0;

globalThis.chrome = {
  tabs: {
    async query() {
      return structuredClone(queryResults.shift() || []);
    },
    async create(properties) {
      createCalls += 1;
      await Promise.resolve();
      return {
        id: 100 + createCalls,
        status: "loading",
        url: properties.url,
        ...properties
      };
    }
  }
};

const {
  findMatchingTabs,
  findOrCreateMatchingTab,
  matchesTargetUrl
} = await import("../src/tabs.js");

const target = {
  id: "admin",
  pageUrl: "https://admin.example.com/home",
  urlPatterns: ["https://admin.example.com/*"],
  urlIncludes: ["https://admin.example.com/home"]
};

test("a tab navigating to pageUrl is matched through pendingUrl", async () => {
  queryResults.push(
    [],
    [{ id: 7, url: "https://admin.example.com/login", pendingUrl: target.pageUrl }]
  );

  const tabs = await findMatchingTabs(target, { log: false });
  assert.deepEqual(tabs.map((tab) => tab.id), [7]);
});

test("pageUrl matching tolerates query, hash, and trailing-slash normalization", () => {
  const pageTarget = {
    pageUrl: "https://admin.example.com/home/",
    urlPatterns: [],
    urlIncludes: [],
    urlRegexes: []
  };

  assert.equal(matchesTargetUrl("https://admin.example.com/home?from=login#/dashboard", pageTarget), true);
  assert.equal(matchesTargetUrl("https://admin.example.com/another", pageTarget), false);
});

test("different configured paths do not share a prefix-matching tab", () => {
  const pageTarget = {
    pageUrl: "https://admin.example.com/app",
    urlPatterns: [],
    urlIncludes: [],
    urlRegexes: []
  };

  assert.equal(matchesTargetUrl("https://admin.example.com/app", pageTarget), true);
  assert.equal(matchesTargetUrl("https://admin.example.com/app-two", pageTarget), false);
  assert.equal(matchesTargetUrl("https://admin.example.com/app/orders", pageTarget), false);
});

test("configured query and hash distinguish pageUrl targets on the same path", () => {
  const queryTarget = {
    pageUrl: "https://admin.example.com/home?site=one",
    urlPatterns: [],
    urlIncludes: [],
    urlRegexes: []
  };
  const hashTarget = {
    ...queryTarget,
    pageUrl: "https://admin.example.com/home#/site-one"
  };

  assert.equal(matchesTargetUrl("https://admin.example.com/home?site=one&dialog=open", queryTarget), true);
  assert.equal(matchesTargetUrl("https://admin.example.com/home?site=two", queryTarget), false);
  assert.equal(matchesTargetUrl("https://admin.example.com/home#/site-one/", hashTarget), true);
  assert.equal(matchesTargetUrl("https://admin.example.com/home#/site-two", hashTarget), false);
});

test("explicit Chrome patterns still reject unrelated tabs during fallback scans", () => {
  assert.equal(
    matchesTargetUrl("https://unrelated.example.com/home", {
      pageUrl: target.pageUrl,
      urlPatterns: target.urlPatterns,
      urlIncludes: [],
      urlRegexes: []
    }),
    false
  );
});

test("concurrent missing-page opens create only one tab", async () => {
  createCalls = 0;
  queryResults.push([], [], [], []);

  const [first, second] = await Promise.all([
    findOrCreateMatchingTab(target, { active: true }),
    findOrCreateMatchingTab(target, { active: true })
  ]);

  assert.equal(createCalls, 1);
  assert.equal(first.tab.id, second.tab.id);
  assert.deepEqual([first.joined, second.joined].sort(), [false, true]);
});
