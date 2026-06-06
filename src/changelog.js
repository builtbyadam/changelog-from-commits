// Pure logic for changelog-from-commits. No @actions imports and no
// child_process here so it can be unit-tested directly over plain data
// (see test/changelog.test.js). Git interaction and Octokit glue live in
// src/index.js.

// A conventional-commit subject: type, optional (scope), optional "!"
// breaking marker, then ": " and the description.
//   feat: add thing
//   fix(api): handle null
//   feat!: drop support for X
//   refactor(core)!: rework engine
const CONVENTIONAL_RE = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:[ \t]+(?<subject>.+)$/;

// "BREAKING CHANGE:" / "BREAKING-CHANGE:" footer (case-insensitive token,
// per the Conventional Commits spec the token itself is uppercase, but we
// accept the hyphen variant which the spec treats as synonymous).
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;

const UNIT = ""; // field separator within a record
const RECORD = ""; // record separator between commits

/**
 * Split the raw `git log` output into individual commit records.
 * The log is formatted as `%H<US>%B<RS>` so each record is
 * "hash<US>body" and records are separated by <RS>.
 *
 * @param {string} raw Raw git log output.
 * @returns {{hash: string, body: string}[]}
 */
function parseLog(raw) {
  if (!raw) return [];
  return raw
    .split(RECORD)
    .map((chunk) => chunk.replace(/^\r?\n/, "")) // strip the newline git emits after %x1e
    .filter((chunk) => chunk.trim().length > 0)
    .map(parseCommitLine);
}

/**
 * Parse one "hash<US>body" record into structured fields. The first line of
 * the body is the subject; the remainder is the message body used for
 * BREAKING CHANGE footer detection.
 *
 * @param {string} record A single "hash<US>body" record.
 * @returns {{hash: string, subject: string, body: string}}
 */
function parseCommitLine(record) {
  const sep = record.indexOf(UNIT);
  const hash = sep === -1 ? "" : record.slice(0, sep).trim();
  const full = sep === -1 ? record : record.slice(sep + 1);
  const normalized = full.replace(/\r\n/g, "\n");
  const newline = normalized.indexOf("\n");
  const subject = (newline === -1 ? normalized : normalized.slice(0, newline)).trim();
  const body = newline === -1 ? "" : normalized.slice(newline + 1);
  return { hash, subject, body };
}

/**
 * Parse a commit into conventional-commit structure. Returns null when the
 * subject does not conform (caller skips it) or when it is a merge commit.
 *
 * @param {{hash: string, subject: string, body: string}} commit
 * @returns {{type: string, scope: string|null, breaking: boolean, subject: string, hash: string}|null}
 */
function parseConventionalCommit(commit) {
  const subject = (commit.subject || "").trim();
  if (!subject) return null;
  // Merge commits are noise in a changelog.
  if (subject.startsWith("Merge ")) return null;

  const m = CONVENTIONAL_RE.exec(subject);
  if (!m || !m.groups) return null;

  const body = commit.body || "";
  const breaking = Boolean(m.groups.bang) || BREAKING_FOOTER_RE.test(body) || BREAKING_FOOTER_RE.test(subject);

  return {
    type: m.groups.type.toLowerCase(),
    scope: m.groups.scope ? m.groups.scope.trim() : null,
    breaking,
    subject: m.groups.subject.trim(),
    hash: commit.hash || "",
  };
}

/**
 * Validate and parse the `commit-types` input: a JSON object mapping a commit
 * type (string) to a section heading (string).
 *
 * @param {string} json Raw JSON object string.
 * @returns {Record<string,string>}
 */
function parseTypeMap(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Input "commit-types" is not valid JSON: ${e.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('Input "commit-types" must be a JSON object mapping type to section heading.');
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw new Error('Input "commit-types" must be a non-empty JSON object.');
  }
  for (const [type, heading] of entries) {
    if (typeof heading !== "string" || heading.length === 0) {
      throw new Error(`Input "commit-types" value for "${type}" must be a non-empty string.`);
    }
  }
  return parsed;
}

/**
 * Group parsed conventional commits into changelog sections. Breaking changes
 * always form a "Breaking Changes" section FIRST, regardless of type. The
 * remaining sections follow the order of `typeMap`'s keys; commit types not in
 * the map are dropped (non-conforming-to-the-configured-vocabulary).
 *
 * A breaking commit also still appears under its own type section.
 *
 * @param {Array} commits   Output of parseConventionalCommit (non-null entries).
 * @param {Record<string,string>} typeMap Type -> heading map.
 * @returns {{heading: string, type: string|null, commits: Array}[]} Ordered, non-empty groups.
 */
function groupCommits(commits, typeMap) {
  const breaking = commits.filter((c) => c.breaking);
  const groups = [];

  if (breaking.length > 0) {
    groups.push({ heading: "Breaking Changes", type: null, commits: breaking });
  }

  for (const [type, heading] of Object.entries(typeMap)) {
    const matched = commits.filter((c) => c.type === type);
    if (matched.length > 0) {
      groups.push({ heading, type, commits: matched });
    }
  }

  return groups;
}

/** Render a single commit as a markdown list item. */
function renderCommit(commit) {
  const scope = commit.scope ? `**${commit.scope}:** ` : "";
  const shortHash = commit.hash ? ` (${commit.hash.slice(0, 7)})` : "";
  return `- ${scope}${commit.subject}${shortHash}`;
}

/**
 * Render the grouped commits into a markdown changelog section.
 *
 * @param {Array} groups Output of groupCommits.
 * @param {{version?: string, date?: string}} [meta] Optional heading metadata.
 * @returns {string} The rendered section, or "" when there are no groups.
 */
function renderChangelog(groups, meta = {}) {
  if (!groups || groups.length === 0) return "";

  const title = meta.version ? meta.version : "Unreleased";
  const date = meta.date ? ` - ${meta.date}` : "";
  const lines = [`## ${title}${date}`, ""];

  for (const group of groups) {
    lines.push(`### ${group.heading}`, "");
    for (const commit of group.commits) {
      lines.push(renderCommit(commit));
    }
    lines.push("");
  }

  // Collapse the trailing blank line into a single newline-terminated string.
  return lines.join("\n").replace(/\n+$/, "\n");
}

/**
 * Prepend a freshly rendered section to existing changelog content without
 * clobbering it. If the existing content opens with a top-level "# " title
 * (e.g. "# Changelog"), the new section is inserted *below* that title and
 * above the previous entries. Otherwise the new section goes on top.
 *
 * @param {string} existingContent Current file content ("" if the file is new).
 * @param {string} newSection      Rendered section from renderChangelog.
 * @returns {string} The combined file content.
 */
function prependToExisting(existingContent, newSection) {
  const section = newSection.replace(/\n+$/, "") + "\n";
  const existing = (existingContent || "").replace(/^﻿/, ""); // strip any BOM

  if (existing.trim().length === 0) {
    return `# Changelog\n\n${section}`;
  }

  const lines = existing.replace(/\r\n/g, "\n").split("\n");
  // Detect a leading H1 title block (the first non-empty line is "# ...").
  let firstNonEmpty = 0;
  while (firstNonEmpty < lines.length && lines[firstNonEmpty].trim() === "") firstNonEmpty++;

  if (firstNonEmpty < lines.length && /^#\s+/.test(lines[firstNonEmpty])) {
    // Keep the title (and any blank lines right after it), insert below.
    let insertAt = firstNonEmpty + 1;
    while (insertAt < lines.length && lines[insertAt].trim() === "") insertAt++;
    const head = lines.slice(0, firstNonEmpty + 1).join("\n");
    const rest = lines.slice(insertAt).join("\n");
    return `${head}\n\n${section}\n${rest}`.replace(/\n{3,}/g, "\n\n");
  }

  // No title: the new section goes on top of the existing content verbatim.
  return `${section}\n${existing}`.replace(/\n{3,}/g, "\n\n");
}

module.exports = {
  parseLog,
  parseCommitLine,
  parseConventionalCommit,
  parseTypeMap,
  groupCommits,
  renderChangelog,
  prependToExisting,
  renderCommit,
  UNIT,
  RECORD,
};
