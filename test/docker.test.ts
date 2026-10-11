import { describe, expect, test } from "bun:test";
import { dockerRunArgs, type ContainerSpec } from "../src/docker.ts";
import { filterLines } from "../src/proxy.ts";

const spec: ContainerSpec = {
  name: "slopswarm-r1-bramble-3",
  image: "slopswarm-agent:latest",
  runId: "r1",
  agent: "bramble",
  mounts: { home: "/h/home", self: "/h/self", runtime: "/h/runtime" },
  env: { CLAUDE_CONFIG_DIR: "/runtime" },
  passEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
  argv: ["claude", "-p", "hello"],
  network: "slopswarm-internal",
  proxy: "http://slopswarm-proxy:8888",
  noProxy: ["slopswarm-forge-r1"],
  limits: { cpus: 1, memoryGb: 2, pidsLimit: 256 },
};

/** Value following `flag` (first occurrence). */
function flag(args: string[], f: string): string | undefined {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
}
function all(args: string[], f: string): string[] {
  return args.flatMap((a, i) => (a === f && args[i + 1] !== undefined ? [args[i + 1]!] : []));
}

describe("dockerRunArgs", () => {
  const args = dockerRunArgs(spec);
  const imageAt = args.indexOf(spec.image);
  const opts = args.slice(0, imageAt);

  test("starts with docker run and ends with image + argv", () => {
    expect(args.slice(0, 2)).toEqual(["docker", "run"]);
    expect(args.slice(imageAt)).toEqual([spec.image, ...spec.argv]);
  });

  test("security flags", () => {
    for (const f of ["--rm", "--init", "--read-only"]) expect(opts).toContain(f);
    expect(flag(opts, "--cap-drop")).toBe("ALL");
    expect(flag(opts, "--security-opt")).toBe("no-new-privileges");
    expect(flag(opts, "--user")).toBe("1000:1000");
    expect(flag(opts, "--tmpfs")).toStartWith("/tmp:");
    expect(flag(opts, "--network")).toBe("slopswarm-internal");
    expect(flag(opts, "--cpus")).toBe("1");
    expect(flag(opts, "--memory")).toBe("2048m");
    expect(flag(opts, "--pids-limit")).toBe("256");
    expect(flag(opts, "-w")).toBe("/home/agent");
    expect(opts).not.toContain("--privileged");
  });

  test("labels for emergency kill", () => {
    expect(all(opts, "--label")).toEqual(["slopswarm=1", "slopswarm.run=r1", "slopswarm.agent=bramble"]);
  });

  test("mounts: only the agent's dirs, /self read-only, no docker socket", () => {
    const vols = all(opts, "-v");
    expect(vols).toEqual([
      "/h/home:/home/agent:rw",
      "/h/self:/self:ro",
      "/h/runtime:/runtime:rw",
    ]);
    expect(opts.join(" ")).not.toContain("docker.sock");
    expect(opts).not.toContain("--mount");
  });

  test("proxy env and adapter env", () => {
    const env = all(opts, "-e");
    expect(env).toContain("HTTPS_PROXY=http://slopswarm-proxy:8888");
    expect(env).toContain("https_proxy=http://slopswarm-proxy:8888");
    expect(env).toContain("HOME=/home/agent");
    expect(env).toContain("CLAUDE_CONFIG_DIR=/runtime");
    // The run's forge is reached directly on the internal network.
    expect(env).toContain("NO_PROXY=localhost,127.0.0.1,slopswarm-forge-r1");
    expect(env).toContain("no_proxy=localhost,127.0.0.1,slopswarm-forge-r1");
  });

  test("secrets are passed by name only", () => {
    const env = all(opts, "-e");
    expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env.some((e) => e.startsWith("CLAUDE_CODE_OAUTH_TOKEN="))).toBe(false);
  });
});

describe("proxy filter", () => {
  test("suffix-match regexes, anchored", () => {
    const [re] = filterLines(["api.anthropic.com"]).map((l) => new RegExp(l));
    expect(re!.test("api.anthropic.com")).toBe(true);
    expect(re!.test("eu.api.anthropic.com")).toBe(true);
    expect(re!.test("evilapi.anthropic.com")).toBe(false);
    expect(re!.test("api.anthropic.com.evil.io")).toBe(false);
    expect(re!.test("example.com")).toBe(false);
  });

  test("rejects junk", () => {
    expect(() => filterLines(["*"])).toThrow();
    expect(() => filterLines(["a b.com"])).toThrow();
    expect(() => filterLines(["localhost"])).toThrow();
  });
});
