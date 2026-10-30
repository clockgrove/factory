/**
 * The blind pairwise review (#2224): the benchmark's own judge, frozen with
 * it like the grader, compares two runs' final trees on the Objective's
 * intent and on code quality. A grade says the criteria are met; this says
 * which result a person who owns the intent would rather have.
 *
 * Judge contract (bench/README.md#Pairwise judge): `definition.judge = {
 * command, timeoutMinutes }`. The command runs in a shell, its working
 * directory holding the pair, with BENCH_TREE_A and BENCH_TREE_B (the two
 * final trees), BENCH_OBJECTIVE (the Objective's text), BENCH_DEFINITION and
 * BENCH_OUT in its environment. It writes `{ judgeVersion, intent, quality,
 * reasons }` to BENCH_OUT, `intent` and `quality` each `A`, `B` or `tie`.
 *
 * Blind: which run is A comes from a hash of the two run ids, never from
 * which is the candidate. The trees are fresh checkouts without their Git
 * history, and the Objective and the definition are copies in the pair's
 * directory, so nothing the judge is given names a run, a Factory version,
 * a group or a date. The harness unblinds the answers to run ids, keeps
 * each pair's judgment in the results, and never judges a pair again unless
 * the judge's command or either tree changes.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CHOICES } from "./definition.mjs";
import { checkoutInto, runCommand } from "./grade.mjs";

/** The share of a person's choices a judge agrees with, below which it isn't trusted (`scoring.minJudgeAgreement`). */
export const MIN_JUDGE_AGREEMENT = 0.8;
/** What a pair is judged on. */
export const ASPECTS = ["intent", "quality"];
/** The definition's fields that name groups and runs: left out of the judge's copy. */
const UNBLINDING = ["baseline", "judgeCalibration"];

const percent = (r) => `${Math.round(r * 100)}%`;

/** A pair's key: a hash of its two run ids, whichever order they come in. */
export function pairKey(x, y) {
  return createHash("sha256").update([x, y].sort().join("\n")).digest("hex");
}

/**
 * The pair's blind order, [A, B]: decided by a hash of the two run ids, so
 * the same pair is always in the same order and the order never says which
 * run is the candidate.
 */
export function blindOrder(x, y) {
  const [first, second] = [x, y].sort();
  return Number.parseInt(pairKey(x, y).slice(0, 2), 16) % 2
    ? [second, first]
    : [first, second];
}

/** A judgment's answer on `aspect` as a run id, or `tie`. */
export function winner(judgment, aspect) {
  const choice = judgment[aspect];
  return choice === "tie" ? "tie" : judgment[choice].run;
}

/**
 * Where a run's final tree and Objective are: its run directory (the
 * card's `run.dir`, or `<benchRoot>/<benchmark>/<run id>` for a card scored
 * before cards named it), whose run record names the run repository's
 * checkout and which holds the Objective as filed (objective.md). The tree
 * is the commit the card was graded at, or its end commit.
 */
export function runSource(card, benchRoot = null) {
  const id = card.run.id;
  const dir =
    card.run.dir ??
    (benchRoot ? join(benchRoot, card.benchmark, card.run.id) : null);
  if (!dir)
    return {
      error: `${id} has no run directory: only a harness run is judged (give --bench-root DIR for a card scored before cards named theirs)`,
    };
  const commit = card.grade?.commit ?? card.endCommit ?? null;
  if (!commit) return { error: `${id} has no end commit` };
  let record;
  try {
    record = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
  } catch (error) {
    return { error: `${id}'s run record: ${error.message}` };
  }
  const objective = join(dir, "objective.md");
  if (!existsSync(objective))
    return { error: `${id}'s run directory has no objective.md` };
  if (!record.checkout || !existsSync(record.checkout))
    return {
      error: `${id}'s run repository checkout ${record.checkout ?? "(none)"} does not exist`,
    };
  return { run: id, repo: record.checkout, commit, objective };
}

/** What the judge wrote, checked; throws naming what is wrong. */
function judgeOutput(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`BENCH_OUT is not JSON: ${error.message}`);
  }
  if (typeof value?.judgeVersion !== "string" || !value.judgeVersion)
    throw new Error("BENCH_OUT has no judgeVersion");
  for (const aspect of ASPECTS)
    if (!CHOICES.includes(value[aspect]))
      throw new Error(`BENCH_OUT's ${aspect} must be ${CHOICES.join(", ")}`);
  return {
    judgeVersion: value.judgeVersion,
    intent: value.intent,
    quality: value.quality,
    reasons: value.reasons ?? null,
  };
}

/**
 * The definition's judge on trees A and B (each `{ repo, commit,
 * objective }`, from runSource). The pair's directory, removed after,
 * holds A/ and B/ (fresh checkouts without .git), objective.md, a copy of
 * the definition without the fields that name groups and runs (beside a
 * link to the bench home's graders/, so a judge finds its files as a
 * grader does), and BENCH_OUT. Returns what the judge chose, or `error`.
 */
export async function runJudge(definition, a, b) {
  const { command, timeoutMinutes } = definition.judge;
  const root = mkdtempSync(join(tmpdir(), "bench-judge-"));
  try {
    const trees = {};
    for (const [side, source] of [
      ["A", a],
      ["B", b],
    ]) {
      trees[side] = join(root, side);
      try {
        checkoutInto(source.repo, source.commit, trees[side]);
      } catch (error) {
        return { error: error.message };
      }
      // Its history names the run's repository, dates and Factory's commits.
      rmSync(join(trees[side], ".git"), { recursive: true, force: true });
    }
    if (readFileSync(a.objective, "utf8") !== readFileSync(b.objective, "utf8"))
      return { error: "the two runs' saved Objectives differ" };
    const objective = join(root, "objective.md");
    copyFileSync(a.objective, objective);
    const blinded = JSON.parse(readFileSync(definition.file, "utf8"));
    for (const field of UNBLINDING) delete blinded[field];
    mkdirSync(join(root, "benchmarks"));
    const copy = join(root, "benchmarks", basename(definition.file));
    writeFileSync(copy, `${JSON.stringify(blinded, null, 2)}\n`);
    const graders = resolve(dirname(definition.file), "..", "graders");
    if (existsSync(graders)) symlinkSync(graders, join(root, "graders"));
    const out = join(root, "judgment.json");
    const run = await runCommand(command, {
      cwd: root,
      env: {
        // Not where compare was started, which may be a run's directory.
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !["PWD", "OLDPWD"].includes(name),
          ),
        ),
        BENCH_TREE_A: trees.A,
        BENCH_TREE_B: trees.B,
        BENCH_OBJECTIVE: objective,
        BENCH_DEFINITION: copy,
        BENCH_OUT: out,
      },
      timeoutMs: timeoutMinutes * 60_000,
    });
    const tail = run.output.trim() ? `: ${run.output.trim()}` : "";
    if (run.timedOut)
      return {
        error: `the judge timed out after ${timeoutMinutes} min${tail}`,
      };
    if (run.code !== 0)
      return {
        error: `the judge exited ${run.code ?? run.signal ?? "without a code"}${tail}`,
      };
    try {
      return judgeOutput(readFileSync(out, "utf8"));
    } catch (error) {
      return {
        error:
          error.code === "ENOENT"
            ? "the judge wrote nothing to BENCH_OUT"
            : error.message,
      };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Cards `x` and `y` judged as a blind pair, or the judgment kept in `dir`
 * (the results' judgments/) when the same judge command judged the same two
 * trees before. A judgment: `{ A: { run, commit }, B: { run, commit },
 * command, judgeVersion, intent, quality, reasons }`, with `cached`; or
 * `{ error }`, which isn't kept, so the pair is judged again next time.
 */
export async function judgePair(definition, x, y, { dir, benchRoot }) {
  const order = blindOrder(x.run.id, y.run.id);
  const cards = order.map((id) => (id === x.run.id ? x : y));
  const [a, b] = cards.map((card) => runSource(card, benchRoot));
  const missing = [a, b].find((source) => source.error);
  if (missing) return { error: missing.error };
  const { command } = definition.judge;
  const file = join(dir, `${pairKey(x.run.id, y.run.id)}.json`);
  let kept = null;
  try {
    kept = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Not judged yet.
  }
  if (
    kept?.command === command &&
    kept.A?.run === a.run &&
    kept.A?.commit === a.commit &&
    kept.B?.run === b.run &&
    kept.B?.commit === b.commit
  )
    return { ...kept, cached: true };
  const judged = await runJudge(definition, a, b);
  if (judged.error) return judged;
  const judgment = {
    A: { run: a.run, commit: a.commit },
    B: { run: b.run, commit: b.commit },
    command,
    ...judged,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(judgment, null, 2)}\n`);
  return { ...judgment, cached: false };
}

/**
 * The candidate's win rate on each aspect over `judgments` (unblinded):
 * a win counts 1, a tie a half, a loss 0. Null with no judgment.
 */
export function winRates(judgments, candidates) {
  const rate = (aspect) =>
    judgments.length
      ? judgments.reduce((sum, judgment) => {
          const won = winner(judgment, aspect);
          return sum + (won === "tie" ? 0.5 : candidates.has(won) ? 1 : 0);
        }, 0) / judgments.length
      : null;
  return {
    pairs: judgments.length,
    intent: rate("intent"),
    quality: rate("quality"),
  };
}

/**
 * How often the judge chose as a person did: each calibration entry
 * (`{ runA, runB, intent, quality, by, at }`, A and B the person's own
 * order) with its `judgment`, compared as run ids. Each aspect of each
 * pair is one choice. Rates are null with no choice.
 */
export function agreementOf(entries) {
  const person = (entry, aspect) =>
    entry[aspect] === "tie"
      ? "tie"
      : entry[aspect] === "A"
        ? entry.runA
        : entry.runB;
  const agreed = Object.fromEntries(
    ASPECTS.map((aspect) => [
      aspect,
      entries.filter(
        (entry) => person(entry, aspect) === winner(entry.judgment, aspect),
      ).length,
    ]),
  );
  const rate = (n, of) => (of ? n / of : null);
  const all = ASPECTS.reduce((sum, aspect) => sum + agreed[aspect], 0);
  return {
    choices: entries.length * ASPECTS.length,
    agreed: all,
    rate: rate(all, entries.length * ASPECTS.length),
    intent: rate(agreed.intent, entries.length),
    quality: rate(agreed.quality, entries.length),
  };
}

/**
 * The blind pairwise review of a candidate group against the baseline:
 * every candidate run paired with every baseline run, each pair judged
 * once (judgments kept in `dir`), and the candidate's win rates. Then the
 * definition's calibration pairs (any runs in `cards`), judged the same
 * way, and how often the judge agrees with the person; a warning when that
 * is below `scoring.minJudgeAgreement`, or when there is nothing to
 * calibrate it with.
 */
export async function pairwise(
  definition,
  { baseline, candidate, cards, dir, benchRoot = null },
) {
  const warnings = [];
  const judge = (x, y) => judgePair(definition, x, y, { dir, benchRoot });
  const pairs = [];
  for (const c of candidate)
    for (const b of baseline) {
      const judged = await judge(c, b);
      if (judged.error)
        warnings.push(
          `${c.run.id} against ${b.run.id} wasn't judged: ${judged.error}`,
        );
      pairs.push({ candidate: c.run.id, baseline: b.run.id, ...judged });
    }
  const judged = pairs.filter((pair) => !pair.error);
  const rates = winRates(judged, new Set(candidate.map((c) => c.run.id)));

  const min = definition.scoring?.minJudgeAgreement ?? MIN_JUDGE_AGREEMENT;
  const given = definition.judgeCalibration ?? [];
  const byId = new Map(cards.map((card) => [card.run.id, card]));
  const entries = [];
  for (const entry of given) {
    const name = `calibration pair ${entry.runA}, ${entry.runB}`;
    const lost = [entry.runA, entry.runB].filter((id) => !byId.has(id));
    if (lost.length) {
      warnings.push(`${name}: no scorecard of ${lost.join(", ")}`);
      continue;
    }
    const judgment = await judge(byId.get(entry.runA), byId.get(entry.runB));
    if (judgment.error) {
      warnings.push(`${name} wasn't judged: ${judgment.error}`);
      continue;
    }
    entries.push({ ...entry, judgment });
  }
  const agreement = agreementOf(entries);
  const calibrated = entries.length > 0;
  if (!calibrated)
    warnings.push(
      given.length
        ? `the judge is uncalibrated: none of its ${given.length} calibration pair(s) could be judged`
        : "the judge is uncalibrated: the definition has no judgeCalibration (record a person's choices with report.mjs calibrate)",
    );
  else if (agreement.rate < min)
    warnings.push(
      `the judge agrees with the person on ${agreement.agreed} of ${agreement.choices} choices (${percent(agreement.rate)}), below ${percent(min)}: its pairwise verdict isn't to be trusted`,
    );
  return {
    pairs,
    rates,
    calibration: { calibrated, min, ...agreement, entries },
    warnings,
  };
}
