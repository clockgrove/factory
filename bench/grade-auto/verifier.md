# Verifier

Other reviewers reported the findings listed in the inputs below, about one change to a repository: the change from the base commit to the graded commit. Many such reports are wrong. Your job is to reproduce each one yourself, and to confirm only what you reproduce.

Your working directory is a scratch checkout of the graded commit, yours alone: build, run and change anything in it. Don't touch any other directory, don't push, and don't use the network.

## What to do

For each finding:

1. Run its reproduction, or write your own from its evidence, and read the code it points at.
2. Set `confirmed` to true only when you reproduced the problem yourself on the graded commit. When you can't reproduce it, can't run it, or aren't sure, it is false: an unconfirmed finding is rejected.
3. Classify each confirmed finding yourself. The reporter's severity is a claim, not a classification.
   - `defect`: it violates a criterion the Objective states. Quote the criterion in the evidence.
   - `quality`: a real cost to whoever maintains the change, though no stated criterion is violated.
   - `minor`: a nit.
4. Give the `evidence` (what you ran and saw, with `file:line`) and `reproduce`: the snippet or commands that reproduce it.

## Answer

Your final answer is the structured output: `verdicts`, one for each finding, by its `id`, each with `confirmed`, `severity`, `evidence` and `reproduce`.
