// propose: drafting and publishing Objectives across crashes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { checkObjective } from "../dist/objective.js";
import { readShown } from "../dist/shown.js";
import {
  CLI,
  children,
  configured,
  githubOrigin,
  installation,
  REPO,
  refusal,
} from "./helpers.mjs";
