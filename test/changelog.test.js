const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  parseLog,
  parseCommitLine,
  parseConventionalCommit,
  parseTypeMap,
  groupCommits,
  renderChangelog,
  prependToExisting,
  UNIT,
  RECORD,
} = require("../src/changelog");

const DEFAULT_TYPES = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance",
  refactor: "Refactoring",
  docs: "Documentation",
  chore: "Chores",
};

// Build a raw git-log record the way index.js formats it: %H<US>%B<RS>.
function record(hash, body) {
  return `${hash}${UNIT}${body}${RECORD}\n`;
}

describe("parseCommitLine", () => {
  test("splits hash from body and isolates the subject", () => {
    const c = parseCommitLine(`abc123${UNIT}feat: add thing\n\nbody line`);
    assert.strictEqual(c.hash, "abc123");
    assert.strictEqual(c.subject, "feat: add thing");
    assert.strictEqual(c.body, "\nbody line");
  });

  test("handles a subject-only commit (no body)", () => {
    const c = parseCommitLine(`deadbee${UNIT}fix: oops`);
    assert.strictEqual(c.subject, "fix: oops");
    assert.strictEqual(c.body, "");
  });
});

describe("parseConventionalCommit", () => {
  const parse = (subject, body = "") => parseConventionalCommit({ hash: "abcdef0", subject, body });

  test("parses feat", () => {
    const r = parse("feat: add login");
    assert.strictEqual(r.type, "feat");
    assert.strictEqual(r.scope, null);
    assert.strictEqual(r.breaking, false);
    assert.strictEqual(r.subject, "add login");
  });

  test("parses fix", () => {
    assert.strictEqual(parse("fix: handle null").type, "fix");
  });

  test("parses chore", () => {
    assert.strictEqual(parse("chore: bump deps").type, "chore");
  });

  test("parses feat(scope)", () => {
    const r = parse("feat(api): paginate");
    assert.strictEqual(r.type, "feat");
    assert.strictEqual(r.scope, "api");
    assert.strictEqual(r.subject, "paginate");
  });

  test("parses feat! as breaking", () => {
    const r = parse("feat!: drop node 16");
    assert.strictEqual(r.type, "feat");
    assert.strictEqual(r.breaking, true);
  });

  test("parses scope with bang: refactor(core)!", () => {
    const r = parse("refactor(core)!: rework engine");
    assert.strictEqual(r.type, "refactor");
    assert.strictEqual(r.scope, "core");
    assert.strictEqual(r.breaking, true);
  });

  test("detects BREAKING CHANGE footer in body", () => {
    const r = parse("feat: new api", "Some detail\n\nBREAKING CHANGE: removed old api");
    assert.strictEqual(r.breaking, true);
  });

  test("accepts the BREAKING-CHANGE hyphen variant", () => {
    const r = parse("feat: new api", "BREAKING-CHANGE: removed old api");
    assert.strictEqual(r.breaking, true);
  });

  test("returns null for non-conforming subjects", () => {
    assert.strictEqual(parse("just some words"), null);
    assert.strictEqual(parse("WIP"), null);
    assert.strictEqual(parse(""), null);
  });

  test("skips merge commits", () => {
    assert.strictEqual(parse("Merge pull request #12 from foo/bar"), null);
  });

  test("lowercases the type", () => {
    assert.strictEqual(parse("Feat: capitalized type").type, "feat");
  });
});

describe("parseLog", () => {
  test("parses multiple records and skips non-conforming via parseConventionalCommit", () => {
    const raw =
      record("h1", "feat: a") +
      record("h2", "fix(api): b\n\nbody") +
      record("h3", "noise commit");
    const commits = parseLog(raw);
    assert.strictEqual(commits.length, 3);
    const parsed = commits.map(parseConventionalCommit).filter(Boolean);
    assert.strictEqual(parsed.length, 2);
  });

  test("empty range yields no commits", () => {
    assert.deepStrictEqual(parseLog(""), []);
    assert.deepStrictEqual(parseLog("\n"), []);
  });
});

describe("parseTypeMap", () => {
  test("accepts the default map", () => {
    const m = parseTypeMap(JSON.stringify(DEFAULT_TYPES));
    assert.strictEqual(m.feat, "Features");
  });

  test("rejects invalid JSON", () => {
    assert.throws(() => parseTypeMap("{nope"), /not valid JSON/);
  });

  test("rejects arrays and non-objects", () => {
    assert.throws(() => parseTypeMap("[]"), /must be a JSON object/);
    assert.throws(() => parseTypeMap('"x"'), /must be a JSON object/);
  });

  test("rejects empty object", () => {
    assert.throws(() => parseTypeMap("{}"), /non-empty JSON object/);
  });

  test("rejects non-string headings", () => {
    assert.throws(() => parseTypeMap('{"feat":1}'), /must be a non-empty string/);
    assert.throws(() => parseTypeMap('{"feat":""}'), /must be a non-empty string/);
  });
});

describe("groupCommits", () => {
  const commits = [
    { type: "feat", scope: null, breaking: false, subject: "a", hash: "1" },
    { type: "fix", scope: "api", breaking: false, subject: "b", hash: "2" },
    { type: "chore", scope: null, breaking: false, subject: "c", hash: "3" },
    { type: "feat", scope: null, breaking: true, subject: "d", hash: "4" },
  ];

  test("breaking changes section comes first", () => {
    const groups = groupCommits(commits, DEFAULT_TYPES);
    assert.strictEqual(groups[0].heading, "Breaking Changes");
    assert.strictEqual(groups[0].commits.length, 1);
    assert.strictEqual(groups[0].commits[0].subject, "d");
  });

  test("remaining sections follow typeMap key order", () => {
    const groups = groupCommits(commits, DEFAULT_TYPES);
    const headings = groups.map((g) => g.heading);
    assert.deepStrictEqual(headings, ["Breaking Changes", "Features", "Bug Fixes", "Chores"]);
  });

  test("a breaking commit still appears under its own type", () => {
    const groups = groupCommits(commits, DEFAULT_TYPES);
    const features = groups.find((g) => g.heading === "Features");
    assert.ok(features.commits.some((c) => c.subject === "d"));
  });

  test("types absent from the map are dropped", () => {
    const groups = groupCommits([{ type: "style", breaking: false, subject: "x" }], DEFAULT_TYPES);
    assert.deepStrictEqual(groups, []);
  });

  test("no commits yields no groups", () => {
    assert.deepStrictEqual(groupCommits([], DEFAULT_TYPES), []);
  });
});

describe("renderChangelog", () => {
  const groups = [
    {
      heading: "Features",
      type: "feat",
      commits: [
        { scope: null, subject: "add login", hash: "abcdef1234" },
        { scope: "api", subject: "paginate", hash: "1234567890" },
      ],
    },
    {
      heading: "Bug Fixes",
      type: "fix",
      commits: [{ scope: null, subject: "handle null", hash: "fedcba9876" }],
    },
  ];

  test("renders a heading per group and a list item per commit", () => {
    const out = renderChangelog(groups, { date: "2026-06-06" });
    assert.match(out, /^## Unreleased - 2026-06-06/);
    assert.match(out, /### Features/);
    assert.match(out, /### Bug Fixes/);
    assert.match(out, /- add login \(abcdef1\)/);
    assert.match(out, /- \*\*api:\*\* paginate \(1234567\)/);
  });

  test("uses version in heading when provided", () => {
    const out = renderChangelog(groups, { version: "v1.2.0", date: "2026-06-06" });
    assert.match(out, /^## v1\.2\.0 - 2026-06-06/);
  });

  test("empty groups render to empty string", () => {
    assert.strictEqual(renderChangelog([]), "");
  });

  test("ends with a single trailing newline", () => {
    const out = renderChangelog(groups, { date: "2026-06-06" });
    assert.ok(out.endsWith("\n"));
    assert.ok(!out.endsWith("\n\n"));
  });
});

describe("prependToExisting", () => {
  const section = "## Unreleased - 2026-06-06\n\n### Features\n\n- add login\n";

  test("creates a Changelog title when the file is new", () => {
    const out = prependToExisting("", section);
    assert.match(out, /^# Changelog\n/);
    assert.ok(out.includes("### Features"));
  });

  test("inserts below an existing H1 title and preserves prior entries", () => {
    const existing = "# Changelog\n\n## v1.0.0 - 2026-01-01\n\n### Features\n\n- old feature\n";
    const out = prependToExisting(existing, section);
    // Title preserved exactly once at the top.
    assert.match(out, /^# Changelog\n/);
    assert.strictEqual((out.match(/^# Changelog$/gm) || []).length, 1);
    // New section appears above the old one.
    const newIdx = out.indexOf("## Unreleased - 2026-06-06");
    const oldIdx = out.indexOf("## v1.0.0 - 2026-01-01");
    assert.ok(newIdx > -1 && oldIdx > -1 && newIdx < oldIdx, "new section must precede old");
    // Old content not clobbered.
    assert.ok(out.includes("- old feature"));
  });

  test("prepends on top when there is no H1 title", () => {
    const existing = "## v1.0.0 - 2026-01-01\n\n### Features\n\n- old feature\n";
    const out = prependToExisting(existing, section);
    const newIdx = out.indexOf("## Unreleased");
    const oldIdx = out.indexOf("## v1.0.0");
    assert.ok(newIdx < oldIdx);
    assert.ok(out.includes("- old feature"));
  });

  test("double prepend keeps both sections, newest first, title once", () => {
    const first = prependToExisting("", section);
    const section2 = "## Unreleased - 2026-07-01\n\n### Bug Fixes\n\n- later fix\n";
    const second = prependToExisting(first, section2);
    assert.strictEqual((second.match(/^# Changelog$/gm) || []).length, 1);
    const idx2 = second.indexOf("2026-07-01");
    const idx1 = second.indexOf("2026-06-06");
    assert.ok(idx2 > -1 && idx1 > -1 && idx2 < idx1, "newer section must be above older");
    assert.ok(second.includes("- add login"));
    assert.ok(second.includes("- later fix"));
  });
});
