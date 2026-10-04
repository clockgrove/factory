// Records what real GitHub answers where test/support/github-http-fake.mjs
// makes an assumption: native stacks and merge-async, merge refusals, error
// bodies, pull fields under API 2026-03-10, pagination and read-after-write
// lag. Run `node scripts/live-check-probe.mjs`. Creates throwaway
// branches and PRs under probe-TAG/ in clockgrove/factory-smoke, merges some of them
// into main, and writes $TMPDIR/live-check-probe-TAG.json.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { all, api, gh, log, REPO, sleep } from "./live-check.mjs";

async function probe() {
  const tag = `p${Date.now().toString(36)}`;
  const work = join(tmpdir(), `live-check-${tag}`);
  const out = { tag, steps: [] };
  const record = (name, response, keep = (data) => data) => {
    const entry = {
      name,
      status: response.status,
      data: keep(response.data),
    };
    out.steps.push(entry);
    log(name, response.status, JSON.stringify(entry.data).slice(0, 300));
    return response;
  };
  const brief = (data) =>
    typeof data === "object" && data !== null
      ? Object.fromEntries(
          Object.entries(data).filter(([key]) =>
            [
              "message",
              "errors",
              "status",
              "details",
              "documentation_url",
              "merged",
              "sha",
            ].includes(key),
          ),
        )
      : data;
  gh(["repo", "clone", REPO, work, "--", "-q"]);
  const git = (...cmd) =>
    execFileSync("git", ["-C", work, ...cmd], { encoding: "utf8" }).trim();
  const branches = ["a", "b", "c", "d"].map((name) => `probe-${tag}/${name}`);
  git("checkout", "-q", "-b", branches[0]);
  for (const [index, branch] of branches.entries()) {
    if (index === 3) git("checkout", "-q", "-b", branch, "origin/main");
    else if (index) git("checkout", "-q", "-b", branch);
    mkdirSync(join(work, "probe", tag), { recursive: true });
    writeFileSync(join(work, "probe", tag, `${index}.sh`), `echo ${index}\n`);
    git("add", "-A");
    git(
      "-c",
      "user.name=live-check",
      "-c",
      "user.email=live-check@invalid",
      "commit",
      "-qm",
      `probe ${index}`,
    );
  }
  git("push", "-q", "origin", ...branches);
  const heads = Object.fromEntries(
    branches.map((branch) => [branch, git("rev-parse", branch)]),
  );
  const pr = (head, base) =>
    record(
      `POST pulls ${head.split("/")[1]}->${base.split("/").pop()}`,
      api("POST", `repos/${REPO}/pulls`, {
        title: `probe ${head}`,
        head,
        base,
      }),
      (data) => ({ number: data.number, ...brief(data) }),
    ).data.number;
  const [A, B, C] = [
    pr(branches[0], "main"),
    pr(branches[1], branches[0]),
    pr(branches[2], branches[1]),
  ];
  const D = pr(branches[3], "main");
  record(
    "POST pulls duplicate head",
    api("POST", `repos/${REPO}/pulls`, {
      title: "dup",
      head: branches[0],
      base: "main",
    }),
    brief,
  );
  record(
    "POST pulls missing head",
    api("POST", `repos/${REPO}/pulls`, {
      title: "x",
      head: `probe-${tag}/none`,
      base: "main",
    }),
    brief,
  );
  record(
    "GET pull fields (open)",
    api("GET", `repos/${REPO}/pulls/${A}`),
    (data) => ({
      keys: Object.keys(data).sort(),
      merged: data.merged,
      merge_commit_sha: data.merge_commit_sha,
      mergeable_state: data.mergeable_state,
    }),
  );
  record(
    "GET stacks before",
    api("GET", `repos/${REPO}/stacks?pull_request=${A}`),
  );
  record(
    "POST stacks",
    api("POST", `repos/${REPO}/stacks`, { pull_requests: [A, B, C] }),
  );
  record(
    "POST stacks again",
    api("POST", `repos/${REPO}/stacks`, { pull_requests: [A, B, C] }),
    brief,
  );
  record(
    "POST stacks nonexistent PR",
    api("POST", `repos/${REPO}/stacks`, { pull_requests: [D, 999999] }),
    brief,
  );
  record(
    "GET stacks by middle PR",
    api("GET", `repos/${REPO}/stacks?pull_request=${B}`),
  );
  // Required check `check` must pass on every head before merging.
  for (let i = 0; i < 120; i++) {
    const ok = Object.values(heads).every((sha) =>
      api(
        "GET",
        `repos/${REPO}/commits/${sha}/check-runs?check_name=check`,
      ).data.check_runs?.some((run) => run.conclusion === "success"),
    );
    if (ok) break;
    await sleep(5000);
  }
  record(
    "PUT merge on stacked bottom PR",
    api("PUT", `repos/${REPO}/pulls/${A}/merge`, {
      sha: heads[branches[0]],
      merge_method: "merge",
    }),
    brief,
  );
  record(
    "PUT merge-async wrong sha",
    api("PUT", `repos/${REPO}/pulls/${B}/merge-async`, {
      sha: heads[branches[0]],
      merge_method: "merge",
    }),
    brief,
  );
  const submitted = Date.now();
  const first = record(
    "PUT merge-async middle PR",
    api("PUT", `repos/${REPO}/pulls/${B}/merge-async`, {
      sha: heads[branches[1]],
      merge_method: "merge",
      merge_action: "default",
    }),
  );
  record(
    "PUT merge-async again (pending?)",
    api("PUT", `repos/${REPO}/pulls/${B}/merge-async`, {
      sha: heads[branches[1]],
      merge_method: "merge",
      merge_action: "default",
    }),
  );
  const uuid = first.data?.details?.uuid;
  const polls = [];
  for (let i = 0; uuid && i < 240; i++) {
    const poll = api("GET", `repos/${REPO}/pulls/${B}/merge-async/${uuid}`);
    polls.push(
      `${Date.now() - submitted}ms:${poll.status}:${poll.data?.status}`,
    );
    if (
      poll.status === 200 &&
      poll.data?.status !== "pending" &&
      poll.data?.status !== "queued"
    ) {
      record("GET merge-async final", poll);
      break;
    }
    await sleep(1000);
  }
  out.steps.push({ name: "merge-async polls", polls });
  const mergedView = (number) => {
    const pull = api("GET", `repos/${REPO}/pulls/${number}`).data;
    const events = all(
      `repos/${REPO}/issues/${number}/timeline?per_page=100`,
    ).filter((event) =>
      ["merged", "closed", "base_ref_changed", "head_ref_deleted"].includes(
        event.event,
      ),
    );
    return {
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.merged_at,
      merge_commit_sha: pull.merge_commit_sha,
      base: pull.base.ref,
      events: events.map((event) => `${event.event}:${event.commit_id ?? ""}`),
    };
  };
  out.steps.push({ name: "after stack merge A", view: mergedView(A) });
  out.steps.push({ name: "after stack merge B", view: mergedView(B) });
  out.steps.push({ name: "after stack merge C", view: mergedView(C) });
  const main = api("GET", `repos/${REPO}/commits/main`).data;
  out.steps.push({
    name: "main head",
    sha: main.sha,
    parents: main.parents.map((parent) => parent.sha),
    message: main.commit.message.split("\n")[0],
    heads,
  });
  record(
    "GET stacks after partial merge",
    api("GET", `repos/${REPO}/stacks?pull_request=${C}`),
  );
  record(
    "PUT merge-async merged PR",
    api("PUT", `repos/${REPO}/pulls/${B}/merge-async`, {
      sha: heads[branches[1]],
      merge_method: "merge",
    }),
  );
  record(
    "PUT merge (sync) merged PR",
    api("PUT", `repos/${REPO}/pulls/${B}/merge`, {
      sha: heads[branches[1]],
      merge_method: "merge",
    }),
    brief,
  );
  // Regular PR D: stale sha, then merge, then merge again.
  record(
    "PUT merge stale sha",
    api("PUT", `repos/${REPO}/pulls/${D}/merge`, {
      sha: heads[branches[0]],
      merge_method: "merge",
    }),
    brief,
  );
  for (let i = 0; i < 60; i++) {
    const merge = api("PUT", `repos/${REPO}/pulls/${D}/merge`, {
      sha: heads[branches[3]],
      merge_method: "merge",
    });
    if (merge.status === 200 || i === 59) {
      record(`PUT merge regular (try ${i + 1})`, merge, brief);
      break;
    }
    if (i === 0) record("PUT merge regular first refusal", merge, brief);
    await sleep(5000);
  }
  record(
    "GET pull immediately after merge",
    api("GET", `repos/${REPO}/pulls/${D}`),
    (data) => ({
      merged: data.merged,
      merged_at: data.merged_at,
      merge_commit_sha: data.merge_commit_sha,
    }),
  );
  record(
    "GET timeline immediately after merge",
    api("GET", `repos/${REPO}/issues/${D}/timeline?per_page=100`),
    (data) =>
      data
        .filter((event) => event.event === "merged")
        .map((event) => event.commit_id),
  );
  record(
    "PUT merge merged PR",
    api("PUT", `repos/${REPO}/pulls/${D}/merge`, {
      sha: heads[branches[3]],
      merge_method: "merge",
    }),
    brief,
  );
  record(
    "PUT merge squash",
    api("PUT", `repos/${REPO}/pulls/${C}/merge`, {
      sha: heads[branches[2]],
      merge_method: "squash",
    }),
    brief,
  );
  // Read-after-write lag on projection endpoints.
  const lag = [];
  const parent = api("POST", `repos/${REPO}/issues`, {
    title: `probe ${tag} parent`,
    body: "probe",
  }).data;
  for (let i = 0; i < 3; i++) {
    const child = api("POST", `repos/${REPO}/issues`, {
      title: `probe ${tag} child ${i}`,
      body: `<!-- probe:${tag}:${i} -->`,
    }).data;
    const listed = all(`repos/${REPO}/issues?state=all&per_page=100`).some(
      (issue) => issue.number === child.number,
    );
    const sub = api(
      "POST",
      `repos/${REPO}/issues/${parent.number}/sub_issues`,
      { sub_issue_id: child.id },
    );
    const subs = api(
      "GET",
      `repos/${REPO}/issues/${parent.number}/sub_issues`,
    ).data.map((issue) => issue.number);
    const dep = api(
      "POST",
      `repos/${REPO}/issues/${child.number}/dependencies/blocked_by`,
      { issue_id: parent.id },
    );
    const deps = api(
      "GET",
      `repos/${REPO}/issues/${child.number}/dependencies/blocked_by`,
    ).data.map((issue) => issue.number);
    const subAgain = api(
      "POST",
      `repos/${REPO}/issues/${parent.number}/sub_issues`,
      { sub_issue_id: child.id },
    );
    const depAgain = api(
      "POST",
      `repos/${REPO}/issues/${child.number}/dependencies/blocked_by`,
      { issue_id: parent.id },
    );
    lag.push({
      listedImmediately: listed,
      sub: sub.status,
      subVisible: subs.includes(child.number),
      dep: dep.status,
      depVisible: deps.includes(parent.number),
      subAgain: [subAgain.status, brief(subAgain.data)],
      depAgain: [depAgain.status, brief(depAgain.data)],
    });
    api("PATCH", `repos/${REPO}/issues/${child.number}`, { state: "closed" });
  }
  api("PATCH", `repos/${REPO}/issues/${parent.number}`, { state: "closed" });
  out.steps.push({ name: "read-after-write", lag });
  const paged = api("GET", `repos/${REPO}/issues?state=all&per_page=1`);
  out.steps.push({
    name: "pagination",
    link: paged.headers.link ?? null,
    rate: paged.headers["x-ratelimit-remaining"] ?? null,
  });
  record("GET unknown route", api("GET", `repos/${REPO}/no-such-route`), brief);
  record(
    "PATCH closed issue comment on missing issue",
    api("POST", `repos/${REPO}/issues/999999/comments`, { body: "x" }),
    brief,
  );
  for (const number of [C, D])
    api("PATCH", `repos/${REPO}/pulls/${number}`, { state: "closed" });
  for (const branch of branches)
    api("DELETE", `repos/${REPO}/git/refs/heads/${branch}`);
  rmSync(work, { recursive: true, force: true });
  const path = join(tmpdir(), `live-check-probe-${tag}.json`);
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  log(`probe written to ${path}`);
}

await probe();
