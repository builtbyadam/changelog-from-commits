const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const core = require("@actions/core");
const github = require("@actions/github");
const {
  parseLog,
  parseConventionalCommit,
  parseTypeMap,
  groupCommits,
  renderChangelog,
  prependToExisting,
  UNIT,
  RECORD,
} = require("./changelog");

const execFileAsync = promisify(execFile);

/**
 * Run a git command in `cwd` and return stdout. Throws an Error whose message
 * includes git's stderr so failures are diagnosable.
 */
async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const stderr = (e.stderr || "").toString().trim();
    throw new Error(`git ${args.join(" ")} failed: ${stderr || e.message}`);
  }
}

/** True when the working tree is a shallow clone (history truncated). */
async function isShallow(cwd) {
  try {
    const out = (await git(["rev-parse", "--is-shallow-repository"], cwd)).trim();
    return out === "true";
  } catch {
    return false;
  }
}

/**
 * Resolve the effective from-ref. When the input is empty, use the latest tag
 * (`git describe --tags --abbrev=0`); when there are no tags, return null,
 * meaning "the beginning of history". (A root-commit SHA would NOT work here:
 * `git log <root>..<to>` is an exclusive range and silently drops the root
 * commit itself from the changelog.)
 */
async function resolveFromRef(input, cwd) {
  if (input) return input;
  try {
    const tag = (await git(["describe", "--tags", "--abbrev=0"], cwd)).trim();
    if (tag) {
      core.info(`from-ref not given; using latest tag "${tag}".`);
      return tag;
    }
  } catch {
    // No tags — fall through to the beginning of history.
  }
  core.info("from-ref not given and no tags found; using the full history.");
  return null;
}

/**
 * Read the git log for `from..to` (or all of `to` when `from` is null —
 * inclusive of the root commit) and parse it into structured commits.
 */
async function readRangeCommits(fromRef, toRef, cwd) {
  // When the endpoints are identical the range is empty by definition.
  if (fromRef !== null && fromRef === toRef) return [];
  // %H<US>%B<RS> — hash, unit separator, full body, record separator.
  const format = `%H${UNIT}%B${RECORD}`;
  const range = fromRef === null ? toRef : `${fromRef}..${toRef}`;
  const raw = await git(["log", range, `--format=${format}`], cwd);
  return parseLog(raw);
}

function readExisting(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw e;
  }
}

/**
 * Open a PR with the updated changelog via the GitHub API (no git push). The
 * branch is created from the default branch's current HEAD sha, the file is
 * committed onto that branch with createOrUpdateFileContents, and a PR is
 * opened against the repo's default branch. Returns the PR html_url.
 */
async function openPullRequest({ token, branchName, outputFile, content, runId }) {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  const repoInfo = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoInfo.data.default_branch;

  // Base the new branch on the default branch's current head so the PR diff is
  // clean against base.
  const baseRef = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${defaultBranch}`,
  });
  const baseSha = baseRef.data.object.sha;

  // Create the branch; if it already exists, suffix with the run id and retry.
  let finalBranch = branchName;
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${finalBranch}`,
      sha: baseSha,
    });
  } catch (e) {
    const exists = e.status === 422 || /reference already exists/i.test(e.message || "");
    if (!exists) throw e;
    const suffix = runId || Math.random().toString(36).slice(2, 8);
    finalBranch = `${branchName}-${suffix}`;
    core.warning(`Branch "${branchName}" already exists; using "${finalBranch}" instead.`);
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${finalBranch}`,
      sha: baseSha,
    });
  }

  // Look up the existing file's blob sha on the branch (needed to update it).
  let existingSha;
  try {
    const existing = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: outputFile,
      ref: finalBranch,
    });
    if (!Array.isArray(existing.data) && existing.data.sha) {
      existingSha = existing.data.sha;
    }
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: outputFile,
    message: `docs: update ${outputFile}`,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch: finalBranch,
    ...(existingSha ? { sha: existingSha } : {}),
  });

  const pr = await octokit.rest.pulls.create({
    owner,
    repo,
    title: `docs: update ${outputFile}`,
    head: finalBranch,
    base: defaultBranch,
    body: "Automated changelog update generated by changelog-from-commits.",
  });

  return pr.data.html_url;
}

function setOutputs({ count, prUrl, changelog }) {
  core.setOutput("entries-count", String(count));
  core.setOutput("pr-url", prUrl || "");
  core.setOutput("changelog", changelog || "");
}

async function run() {
  try {
    const workingDir = core.getInput("working-directory") || ".";
    const cwd = path.resolve(workingDir);
    const fromInput = core.getInput("from-ref");
    const toRef = core.getInput("to-ref") || "HEAD";
    const outputFile = core.getInput("output-file") || "CHANGELOG.md";
    const openPrInput = (core.getInput("open-pr") || "true").toLowerCase();
    if (openPrInput !== "true" && openPrInput !== "false") {
      throw new Error(`Input "open-pr" must be "true" or "false", got "${openPrInput}".`);
    }
    const openPr = openPrInput === "true";
    const runId = process.env.GITHUB_RUN_ID || "local";
    const branchNameTemplate = core.getInput("branch-name") || "changelog/update-{run}";
    const branchName = branchNameTemplate.replace(/\{run\}/g, runId);
    const typeMap = parseTypeMap(
      core.getInput("commit-types") ||
        '{"feat":"Features","fix":"Bug Fixes","perf":"Performance","refactor":"Refactoring","docs":"Documentation","chore":"Chores"}'
    );
    const token = core.getInput("github-token");

    // Detect shallow history early — git log over a range is unreliable then.
    if (await isShallow(cwd)) {
      throw new Error(
        "This repository was checked out with shallow history, so the commit range cannot be " +
          "resolved reliably. Set `fetch-depth: 0` on actions/checkout."
      );
    }

    const fromRef = await resolveFromRef(fromInput, cwd);

    const rawCommits = await readRangeCommits(fromRef, toRef, cwd);
    const parsed = rawCommits.map(parseConventionalCommit);
    const conforming = parsed.filter(Boolean);
    const skipped = parsed.length - conforming.length;
    core.info(
      `Parsed ${rawCommits.length} commits, ${conforming.length} conforming, skipped ${skipped}.`
    );

    if (conforming.length === 0) {
      core.info("Nothing to do: no conforming commits in range.");
      setOutputs({ count: 0, prUrl: "", changelog: "" });
      return;
    }

    const groups = groupCommits(conforming, typeMap);
    const date = new Date().toISOString().slice(0, 10);
    const section = renderChangelog(groups, { date });

    if (!section) {
      core.info("Nothing to do: commits matched no configured commit-types.");
      setOutputs({ count: 0, prUrl: "", changelog: "" });
      return;
    }

    const filePath = path.resolve(cwd, outputFile);
    const existing = readExisting(filePath);
    const updated = prependToExisting(existing, section);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, updated, "utf8");
    core.info(`Wrote ${outputFile} (prepended new section, preserved existing content).`);

    let prUrl = "";
    if (openPr) {
      if (token) {
        try {
          prUrl = await openPullRequest({
            token,
            branchName,
            outputFile,
            content: updated,
            runId: runId === "local" ? null : runId,
          });
          core.info(`Opened pull request: ${prUrl}`);
        } catch (e) {
          core.warning(`Failed to open pull request: ${e.message}`);
        }
      } else {
        core.warning(
          "open-pr is true but no github-token was provided; wrote the file and outputs " +
            "but did not open a pull request."
        );
      }
    }

    core.info(`entries-count: ${conforming.length}`);
    setOutputs({ count: conforming.length, prUrl, changelog: section });
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
