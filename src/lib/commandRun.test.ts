import { describe, expect, it } from "vitest";

import {
  clipForShare,
  extractCommand,
  hasPlaceholder,
  isRunnableLang,
  runRisks,
  tailLines,
} from "./commandRun";

describe("isRunnableLang", () => {
  it("unix 认 shell 类语言，不认 powershell 和无语言", () => {
    for (const l of ["bash", "sh", "zsh", "shell", "console", "Bash"]) {
      expect(isRunnableLang(l, "unix")).toBe(true);
    }
    for (const l of ["powershell", "pwsh", "", "js", "text", "python"]) {
      expect(isRunnableLang(l, "unix")).toBe(false);
    }
  });
  it("windows 只认 powershell 一类", () => {
    expect(isRunnableLang("powershell", "windows")).toBe(true);
    expect(isRunnableLang("bash", "windows")).toBe(false);
  });
});

describe("extractCommand", () => {
  it("普通块原样返回，去掉结尾换行", () => {
    expect(extractCommand("bash", "pnpm i\npnpm dev\n")).toBe("pnpm i\npnpm dev");
  });
  it("console 只取提示符后的命令，跳过输出", () => {
    const src = "$ npm -v\n10.2.0\n$ node -v\nv20.1.0";
    expect(extractCommand("console", src)).toBe("npm -v\nnode -v");
  });
  it("console 的续行跟着带上", () => {
    const src = "$ docker run \\\n  -p 80:80 nginx\nstarting…";
    expect(extractCommand("console", src)).toBe("docker run \\\n  -p 80:80 nginx");
  });
  it("console 没有提示符时整块当命令", () => {
    expect(extractCommand("console", "ls -la")).toBe("ls -la");
  });
  it("空块给空串", () => {
    expect(extractCommand("bash", "\n\n")).toBe("");
  });
});

describe("hasPlaceholder", () => {
  it("认得常见占位符", () => {
    expect(hasPlaceholder("export TOKEN=<your-token>")).toBe(true);
    expect(hasPlaceholder("curl -H 'Authorization: YOUR_API_KEY' x")).toBe(true);
    expect(hasPlaceholder("git clone git@github.com:you/your-repo.git")).toBe(true);
  });
  it("重定向、heredoc 不算", () => {
    expect(hasPlaceholder("cat <<EOF > a.txt\nhi\nEOF")).toBe(false);
    expect(hasPlaceholder("sort < in.txt > out.txt")).toBe(false);
    expect(hasPlaceholder("pnpm tauri dev")).toBe(false);
  });
});

describe("runRisks", () => {
  it("普通命令不用确认", () => {
    expect(runRisks("pnpm tauri dev")).toEqual([]);
    expect(runRisks("git push origin master")).toEqual([]);
    expect(runRisks("rm file.txt")).toEqual([]);
    expect(runRisks("npm run build && npm test")).toEqual([]);
  });
  it("复合命令里藏着的高危也能抓到", () => {
    expect(runRisks("npm test && rm -rf /")).toContain("delete");
    expect(runRisks("echo hi; sudo shutdown -h now")).toEqual(
      expect.arrayContaining(["sudo", "system"]),
    );
  });
  it("管道交给 shell", () => {
    expect(runRisks("curl -fsSL https://x.sh | sh")).toContain("pipeToShell");
    expect(runRisks("curl -fsSL https://x.sh | sudo bash")).toContain("pipeToShell");
    expect(runRisks("irm https://x.ps1 | iex")).toContain("pipeToShell");
    expect(runRisks("curl https://api/x | jq .")).toEqual([]);
  });
  it("git 改写历史", () => {
    expect(runRisks("git push -f origin main")).toContain("git");
    expect(runRisks("git push --force-with-lease")).toContain("git");
    expect(runRisks("git reset --hard HEAD~1")).toContain("git");
    expect(runRisks("git clean -fdx")).toContain("git");
  });
  it("看不见的字符", () => {
    expect(runRisks("ls ‮txt.exe")).toContain("hidden");
    expect(runRisks("echo a​b")).toContain("hidden");
    expect(runRisks("echo\tok")).toEqual([]);
  });
  it("长脚本", () => {
    const script = Array.from({ length: 12 }, (_, i) => `echo ${i}`).join("\n");
    expect(runRisks(script)).toContain("long");
    expect(runRisks(`# 注释\n${"echo\n".repeat(5)}`)).toEqual([]);
  });
});

describe("tailLines / clipForShare", () => {
  it("只留最后几行，去掉首尾空行", () => {
    expect(tailLines("\n\na\nb\nc\n\n", 2)).toBe("b\nc");
  });
  it("超长从整行处截", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const r = clipForShare(text, 30);
    expect(r.clipped).toBe(true);
    expect(r.text.startsWith("line ")).toBe(true);
    expect(r.text.endsWith("line 99")).toBe(true);
  });
});
