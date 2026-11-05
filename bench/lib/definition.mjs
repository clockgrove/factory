// Path fix for lib/judge.mjs, which is kept unchanged from Factory 0.5's
// bench: the one export it needs from the 0.5 definition module, which
// otherwise pulled in the 0.5 build (dist/). 0.6 has no benchmark
// definition schema beyond the judge block (see judge.mjs and README.md).

/** A pairwise judge's or a person's choice between trees A and B. */
export const CHOICES = ["A", "B", "tie"];
