import { describe, expect, it } from "vitest";

import { envFieldName, groupEnvVars } from "./envGroups";

const v = (...names: string[]) => names.map((name) => ({ name }));
const shape = (vars: { name: string }[]) =>
  groupEnvVars(vars).map((g) => [g.prefix, g.stem, g.items.map((i) => i.name)]);

describe("groupEnvVars", () => {
  it("共享前缀成组，单个的归到其他", () => {
    expect(
      shape(
        v(
          "FUYAO_API_KEY",
          "MOSS_API_KEY",
          "PERF_SYSTEM_PASSWORD",
          "PERF_SYSTEM_URL",
          "PERF_SYSTEM_USER",
          "SSH_MCP_HOST",
          "SSH_MCP_PASSWORD",
          "SSH_MCP_USERNAME",
          "TDX_API_KEY",
        ),
      ),
    ).toEqual([
      [
        "PERF_SYSTEM",
        "PERF_SYSTEM_",
        ["PERF_SYSTEM_PASSWORD", "PERF_SYSTEM_URL", "PERF_SYSTEM_USER"],
      ],
      [
        "SSH_MCP",
        "SSH_MCP_",
        ["SSH_MCP_HOST", "SSH_MCP_PASSWORD", "SSH_MCP_USERNAME"],
      ],
      [null, "", ["FUYAO_API_KEY", "MOSS_API_KEY", "TDX_API_KEY"]],
    ]);
  });

  it("双下划线是显式分组，一个也成组；多台服务器分得开", () => {
    expect(
      shape(
        v(
          "SSH_PROD__HOST",
          "SSH_PROD__PASSWORD",
          "SSH_TEST__HOST",
          "SOLO__KEY",
        ),
      ),
    ).toEqual([
      ["SOLO", "SOLO__", ["SOLO__KEY"]],
      ["SSH_PROD", "SSH_PROD__", ["SSH_PROD__HOST", "SSH_PROD__PASSWORD"]],
      ["SSH_TEST", "SSH_TEST__", ["SSH_TEST__HOST"]],
    ]);
  });

  it("取最长前缀，落单的不硬凑", () => {
    expect(shape(v("A_B_C", "A_B_D", "A_E"))).toEqual([
      ["A_B", "A_B_", ["A_B_C", "A_B_D"]],
      [null, "", ["A_E"]],
    ]);
  });
});

describe("envFieldName", () => {
  it("去掉组前缀", () => {
    expect(envFieldName("SSH_PROD__HOST", "SSH_PROD")).toBe("HOST");
    expect(envFieldName("PERF_SYSTEM_URL", "PERF_SYSTEM")).toBe("URL");
    expect(envFieldName("MOSS_API_KEY", null)).toBe("MOSS_API_KEY");
  });
});
