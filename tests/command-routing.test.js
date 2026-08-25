import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCommandRouting,
  resolveCommandTargetByAction
} from "../src/command-routing.js";

const firstTarget = {
  id: "website-one",
  commandRouting: {
    allowedOrigins: ["https://api.example.com"],
    pathSegments: ["website-one"]
  }
};
const secondTarget = {
  id: "website-two",
  commandRouting: {
    allowedOrigins: ["https://api.example.com"],
    pathSegments: ["website-two"]
  }
};

test("routes a command by an exact URL path segment instead of the receiving socket", () => {
  const result = resolveCommandTargetByAction(
    [firstTarget, secondTarget],
    "https://api.example.com/v1/website-one/orders",
    secondTarget
  );

  assert.equal(result.ok, true);
  assert.equal(result.mode, "action-path");
  assert.equal(result.target.id, "website-one");
});

test("path segment routing does not match a partial segment", () => {
  const result = resolveCommandTargetByAction(
    [firstTarget, secondTarget],
    "https://api.example.com/v1/website-one-preview/orders",
    secondTarget
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "command-target-not-found");
});

test("rejects an action that matches more than one target", () => {
  const result = resolveCommandTargetByAction(
    [
      {
        id: "prefix-target",
        commandRouting: {
          allowedOrigins: ["https://api.example.com"],
          pathPrefixes: ["/v1"]
        }
      },
      {
        id: "segment-target",
        commandRouting: {
          allowedOrigins: ["https://api.example.com"],
          pathSegments: ["website-one"]
        }
      }
    ],
    "https://api.example.com/v1/website-one/orders",
    null
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "ambiguous-command-target");
  assert.deepEqual(result.matchedTargetIds, ["prefix-target", "segment-target"]);
});

test("origin constraints are combined with path rules", () => {
  const result = resolveCommandTargetByAction(
    [
      {
        id: "website-one",
        commandRouting: {
          allowedOrigins: ["https://api.website-one.example"],
          pathSegments: ["orders"]
        }
      }
    ],
    "https://untrusted.example/v1/orders",
    null
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "command-target-not-found");
});

test("keeps socket-bound behavior when no target configures command routing", () => {
  const fallbackTarget = { id: "legacy", commandRouting: {} };
  const result = resolveCommandTargetByAction(
    [fallbackTarget],
    "not-an-absolute-url",
    fallbackTarget
  );

  assert.equal(result.ok, true);
  assert.equal(result.mode, "socket-bound");
  assert.equal(result.target, fallbackTarget);
});

test("normalizes duplicate and slash-wrapped path segment values", () => {
  const routing = normalizeCommandRouting({
    commandRouting: {
      allowedOrigins: ["https://api.example.com"],
      pathSegments: ["/website-one/", "website-one"]
    }
  });

  assert.equal(routing.configured, true);
  assert.equal(routing.valid, true);
  assert.deepEqual(routing.pathSegments, ["website-one"]);
});

test("requires an exact allowed origin when action routing is enabled", () => {
  const result = resolveCommandTargetByAction(
    [
      {
        id: "unsafe-target",
        commandRouting: { pathSegments: ["website-one"] }
      }
    ],
    "https://api.example.com/v1/website-one/orders",
    null
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-command-routing-config");
  assert.deepEqual(result.invalidTargetIds, ["unsafe-target"]);
});

test("requires every enabled target to participate once action routing is enabled", () => {
  const result = resolveCommandTargetByAction(
    [firstTarget, { id: "unconfigured-target", commandRouting: {} }],
    "https://api.example.com/v1/website-one/orders",
    firstTarget
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-command-routing-config");
  assert.deepEqual(result.missingTargetIds, ["unconfigured-target"]);
});

test("does not allow an origin-only rule to bypass path matching", () => {
  const result = resolveCommandTargetByAction(
    [
      {
        id: "origin-only-target",
        commandRouting: { allowedOrigins: ["https://api.example.com"] }
      }
    ],
    "https://api.example.com/anything",
    null
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-command-routing-config");
});

test("path prefix matching respects a complete segment boundary", () => {
  const target = {
    id: "prefix-target",
    commandRouting: {
      allowedOrigins: ["https://api.example.com"],
      pathPrefixes: ["/v1"]
    }
  };
  const result = resolveCommandTargetByAction(
    [target],
    "https://api.example.com/v10/orders",
    target
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "command-target-not-found");
});

test("rejects a configured pathSegments value that contains an internal slash", () => {
  const routing = normalizeCommandRouting({
    commandRouting: {
      allowedOrigins: ["https://api.example.com"],
      pathSegments: ["website/one", "website%2Ftwo"]
    }
  });

  assert.deepEqual(routing.pathSegments, []);
  assert.equal(routing.valid, false);
});

test("invalid declared rules fail closed instead of falling back to the receiving socket", () => {
  const fallbackTarget = {
    id: "invalid-target",
    commandRouting: {
      allowedOrigins: ["not-an-origin"],
      pathSegments: ["website/one"]
    }
  };
  const result = resolveCommandTargetByAction(
    [fallbackTarget],
    "https://api.example.com/v1/website/one/orders",
    fallbackTarget
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-command-routing-config");
  assert.deepEqual(result.invalidTargetIds, ["invalid-target"]);
});
