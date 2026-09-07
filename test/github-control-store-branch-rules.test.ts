import { describe, expect, it } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";

const rulesDocumentation = "https://docs.github.com/rest/repos/rules#get-rules-for-a-branch";
const protectionDocumentation =
  "https://docs.github.com/rest/branches/branch-protection#get-branch-protection";
const unavailableMessage =
  "Upgrade to GitHub Pro or make this repository public to enable this feature.";

function response(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function unsupported(documentation_url: string) {
  return response({ message: unavailableMessage, documentation_url, status: "403" }, 403);
}

function fixture(handler: (route: string) => Response | Promise<Response>): {
  store: GitHubControlStore;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    store: new GitHubControlStore({
      token: "fixture-only",
      owner: "o",
      repo: "r",
      requestFetch: async (input, init) => {
        const request = new Request(input, init);
        const route = `${request.method} ${new URL(request.url).pathname}`;
        calls.push(route);
        return handler(route);
      },
    }),
  };
}

describe("private repository branch rule capability", () => {
  it("treats unsupported rulesets and absent classic protection as no rules", async () => {
    const f = fixture((route) =>
      route.endsWith("/rules/branches/main")
        ? unsupported(rulesDocumentation)
        : response({ message: "Not Found" }, 404),
    );

    await expect(f.store.readBranchRules("main")).resolves.toEqual([]);
    expect(f.calls).toEqual([
      "GET /repos/o/r/rules/branches/main",
      "GET /repos/o/r/branches/main/protection",
    ]);
  });

  it("retains classic protection when rulesets are unsupported", async () => {
    const f = fixture((route) =>
      route.endsWith("/rules/branches/main")
        ? unsupported(rulesDocumentation)
        : response({
            required_status_checks: {
              strict: true,
              contexts: ["classic-test"],
              checks: [],
            },
          }),
    );

    await expect(f.store.readBranchRules("main")).resolves.toEqual([
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "classic-test" }],
        },
      },
    ]);
  });

  it("retains rulesets when classic protection is unsupported", async () => {
    const rules = [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }];
    const f = fixture((route) =>
      route.endsWith("/rules/branches/main")
        ? response(rules)
        : unsupported(protectionDocumentation),
    );

    await expect(f.store.readBranchRules("main")).resolves.toEqual(rules);
  });

  it.each(["rulesets", "classic protection"])(
    "propagates an unrelated 403 from %s",
    async (source) => {
      const f = fixture((route) => {
        if (route.endsWith("/rules/branches/main")) {
          return source === "rulesets"
            ? response({ message: "Resource not accessible by integration" }, 403)
            : response([]);
        }
        return response({ message: "Resource not accessible by integration" }, 403);
      });

      await expect(f.store.readBranchRules("main")).rejects.toMatchObject({ status: 403 });
    },
  );
});
