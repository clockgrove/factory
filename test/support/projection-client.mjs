import { GitHubRequestError } from "../../dist/github-client.js";
export const roleLabels = ["factory:objective", "factory:work-item"];
/** The token's login: Factory authored every issue unless a test says otherwise. */
export const factoryLogin = "factory-bot";
export function projectionClient(repository, initial = []) {
  const issues = new Map(
    initial.map((issue) => {
      const copy = { user: { login: factoryLogin }, ...structuredClone(issue) };
      delete copy.parent_issue_url;
      return [issue.number, copy];
    }),
  );
  const hierarchy = new Map();
  const deps = new Map();
  const labels = roleLabels.map((name) => ({ name, archived_at: null }));
  const calls = [];
  const issue = (number, value = {}) => ({
    id: 100 + number,
    number,
    title: `Issue ${number}`,
    body: "",
    state: "open",
    labels: [],
    repository_url: `https://api.github.com/repos/${repository}`,
    user: { login: factoryLogin },
    ...value,
  });
  let next = Math.max(1, ...issues.keys()) + 1;
  const client = {
    async viewer() {
      calls.push({ method: "GET", route: "user" });
      return factoryLogin;
    },
    async paginate(route) {
      calls.push({ method: "GET", route });
      if (route.endsWith("/labels")) return structuredClone(labels);
      const number = Number(route.match(/issues\/(\d+)/)?.[1]);
      if (route.includes("blocked_by"))
        return structuredClone(
          (deps.get(number) ?? []).map((n) => issues.get(n)),
        );
      if (route.includes("sub_issues"))
        return structuredClone(
          (hierarchy.get(number) ?? []).map((n) => issues.get(n)),
        );
      return structuredClone([...issues.values()]);
    },
    async request(method, route, body) {
      calls.push({ method, route, body: structuredClone(body) });
      const number = Number(route.match(/issues\/(\d+)/)?.[1]);
      if (method === "GET") {
        if (route.endsWith("/parent")) {
          const parent = [...hierarchy].find(([, children]) =>
            children.includes(number),
          )?.[0];
          if (parent === undefined) throw new GitHubRequestError(404);
          return structuredClone(issues.get(parent));
        }
        if (!issues.has(number)) throw new GitHubRequestError(404);
        return structuredClone(issues.get(number));
      }
      if (route.endsWith("/labels") && !route.includes("/issues/")) {
        labels.push({ name: body.name, color: body.color, archived_at: null });
        return structuredClone(labels.at(-1));
      }
      if (route.endsWith("/labels")) {
        issues
          .get(number)
          .labels.push(
            ...body.labels.filter(
              (name) => !issues.get(number).labels.includes(name),
            ),
          );
        return structuredClone(issues.get(number).labels);
      }
      if (method === "PATCH") {
        Object.assign(issues.get(number), body);
        return structuredClone(issues.get(number));
      }
      if (route.endsWith("/sub_issues")) {
        const child = [...issues.values()].find(
          (entry) => entry.id === body.sub_issue_id,
        );
        const parent = [...hierarchy].find(([, children]) =>
          children.includes(child.number),
        )?.[0];
        if (parent !== undefined && body.replace_parent !== true)
          throw new Error("GitHub request failed (HTTP 422): existing parent");
        if (parent !== undefined)
          hierarchy.set(
            parent,
            hierarchy.get(parent).filter((n) => n !== child.number),
          );
        hierarchy.set(number, [...(hierarchy.get(number) ?? []), child.number]);
        return structuredClone(child);
      }
      if (route.endsWith("/blocked_by")) {
        const dependency = [...issues.values()].find(
          (entry) => entry.id === body.issue_id,
        );
        deps.set(number, [...(deps.get(number) ?? []), dependency.number]);
        return structuredClone(dependency);
      }
      if (method === "POST" && route.endsWith("/issues")) {
        const created = issue(next++, body);
        issues.set(created.number, created);
        return structuredClone(created);
      }
      throw new Error(`Unexpected ${method} ${route}`);
    },
  };
  return { client, issues, hierarchy, deps, labels, calls, issue };
}
