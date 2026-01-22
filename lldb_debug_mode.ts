import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

interface BuildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ArtifactCandidate {
  path: string;
  mtimeMs: number;
  reason: string;
}

interface ArtifactResult {
  chosen: string | null;
  candidates: ArtifactCandidate[];
}

interface LLDBResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const ERROR_LOG_PATH = path.join(process.cwd(), "error.log");

function logError(msg: string, err?: unknown): void {
  const timestamp = new Date().toISOString();
  const errorMsg = err ? `${msg}: ${err instanceof Error ? err.message : String(err)}` : msg;
  const line = `[${timestamp}] ${errorMsg}\n`;
  try {
    fs.appendFileSync(ERROR_LOG_PATH, line);
  } catch {
    console.error("Error log:", line);
  }
}

function execCommand(cmd: string, timeoutMs = 60000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ exitCode: -1, stdout: "", stderr: `Timeout after ${timeoutMs}ms` });
      }
    }, timeoutMs);

    const child = spawn(cmd, { shell: true, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });

    child.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ exitCode: code || 0, stdout, stderr });
      }
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ exitCode: -1, stdout: "", stderr: err.message });
      }
    });
  });
}

async function runBuildCommands(commands: string[]): Promise<BuildResult> {
  if (commands.length === 0) {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  let combinedStdout = "";
  let combinedStderr = "";
  let overallExitCode = 0;

  for (const cmd of commands) {
    logError(`Running build command: ${cmd}`);
    const result = await execCommand(cmd);
    combinedStdout += `> ${cmd}\n${result.stdout}\n`;
    combinedStderr += `> ${cmd}\n${result.stderr}\n`;
    if (result.exitCode !== 0) {
      overallExitCode = result.exitCode;
    }
  }

  return { exitCode: overallExitCode, stdout: combinedStdout, stderr: combinedStderr };
}

async function findNewestExecutable(artifactRoots: string[]): Promise<ArtifactResult> {
  const candidates: ArtifactCandidate[] = [];
  const maxDepth = 3;

  async function scanDirectory(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await scanDirectory(fullPath, depth + 1);
        } else if (entry.isFile()) {
          try {
            const stats = fs.statSync(fullPath);
            let isExecutable = false;
            let reason = "";

            if (process.platform === "win32") {
              if (entry.name.endsWith(".exe")) {
                isExecutable = true;
                reason = "Windows executable (.exe)";
              } else if (entry.name.endsWith(".cmd") || entry.name.endsWith(".bat")) {
                isExecutable = true;
                reason = "Windows script (.cmd/.bat)";
              }
            } else {
              const mode = stats.mode & 0o111;
              if (mode !== 0 && !entry.name.endsWith(".a") && !entry.name.endsWith(".o") && !entry.name.endsWith(".so")) {
                isExecutable = true;
                reason = `Executable (mode: ${stats.mode.toString(8)})`;
              }
            }

            if (isExecutable) {
              candidates.push({
                path: fullPath,
                mtimeMs: stats.mtimeMs,
                reason: reason
              });
            }
          } catch {
            // Skip files we can't stat
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  for (const root of artifactRoots) {
    await scanDirectory(root, 0);
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const chosen = candidates.length > 0 ? candidates[0].path : null;

  return { chosen, candidates: candidates.slice(0, 5) };
}

async function generateLLDBScript(
  breakpointsByName: string[],
  breakpointLogCommands: string[],
  programArgs: string[]
): Promise<string> {
  let script = `settings set auto-confirm true\n`;
  script += `settings set target.stop-on-sharedlibrary-events false\n`;

  let breakpointId = 1;

  for (const symbol of breakpointsByName) {
    script += `breakpoint set --name "${symbol}"\n`;
    script += `breakpoint command add ${breakpointId}\n`;
    script += `thread backtrace all\n`;
    script += `frame variable\n`;

    for (const cmd of breakpointLogCommands) {
      script += `${cmd}\n`;
    }
    script += `process continue\n`;
    script += `DONE\n`;
    breakpointId++;
  }

  if (programArgs.length > 0) {
    script += `settings set target.run-args ${programArgs.map(arg => `"${arg}"`).join(" ")}\n`;
  }

  script += `run\n`;
  script += `process status\n`;
  script += `thread backtrace all\n`;
  script += `quit\n`;

  return script;
}

async function runLLDB(target: string, script: string, maxSeconds: number): Promise<LLDBResult> {
  const tempScriptPath = path.join(process.cwd(), `lldb_script_${Date.now()}.txt`);

  try {
    fs.writeFileSync(tempScriptPath, script);

    const timeoutMs = maxSeconds * 1000;
    const cmd = `lldb --batch -s "${tempScriptPath}" "${target}"`;
    const result = await execCommand(cmd, timeoutMs);

    return result;
  } catch (err) {
    logError("runLLDB error", err);
    return { exitCode: -1, stdout: "", stderr: String(err) };
  } finally {
    try {
      fs.unlinkSync(tempScriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

function parseLLDBOutput(output: string): {
  breakpointsHit: number;
  hasCrash: boolean;
  crashLocation?: string;
  crashedThread?: number;
  breakpointsTriggered: string[];
  exitReason?: string;
} {
  const result = {
    breakpointsHit: 0,
    hasCrash: false,
    crashLocation: undefined as string | undefined,
    crashedThread: undefined as number | undefined,
    breakpointsTriggered: [] as string[],
    exitReason: undefined as string | undefined
  };

  const crashPatterns = [/EXC_BAD_ACCESS|EXC_CRASH|SIGABRT|SIGSEGV|SIGILL/, /Program terminated with signal/, /Process \d+ stopped/, /Thread \d+ crashed/];

  for (const pattern of crashPatterns) {
    if (pattern.test(output)) {
      result.hasCrash = true;
      break;
    }
  }

  const threadBacktraceMatch = output.match(/thread #(\d+),.*queue:'([^']+)'/);
  if (threadBacktraceMatch) {
    result.crashedThread = parseInt(threadBacktraceMatch[1], 10);
  }

  const breakpointMatches = output.match(/Breakpoint \d+ hit/gi);
  result.breakpointsHit = breakpointMatches ? breakpointMatches.length : 0;

  const breakpointNameRegex = /hit breakpoint \d+\.\d+ at ([^\n]+)/gi;
  let match;
  while ((match = breakpointNameRegex.exec(output)) !== null) {
    result.breakpointsTriggered.push(match[1].trim());
  }

  const exitReasonMatch = output.match(/Process \d+ (exited with|terminated with|detached from) ([^\n]+)/i);
  if (exitReasonMatch) {
    result.exitReason = exitReasonMatch[2].trim();
  }

  return result;
}

export default (async function LLDBDebugPlugin() {
  return {
    tool: {
      debug_run: tool({
        description: "Build and debug a program using LLDB with comprehensive breakpoint and analysis support",
        args: {
          buildCommands: tool.schema.array(tool.schema.string()).describe("Shell commands to build the project"),
          programArgs: tool.schema.array(tool.schema.string()).optional().default([]),
          artifactRoots: tool.schema.array(tool.schema.string()).optional().default(["target/debug", "target/release", ".build", "build", "dist", "out", "bin"]),
          breakpointsByName: tool.schema.array(tool.schema.string()).optional().default([]),
          breakpointLogCommands: tool.schema.array(tool.schema.string()).optional().default(["thread backtrace all", "frame variable"]),
          maxSeconds: tool.schema.number().optional().default(20),
          attempt: tool.schema.number().optional().default(1),
          targetOverride: tool.schema.string().optional()
        },
        async execute(args) {
          logError("debug_run.execute called with args:", JSON.stringify(args));

          try {
            const buildCommands = args.buildCommands || [];
            const programArgs = args.programArgs || [];
            const artifactRoots = args.artifactRoots || ["target/debug", "target/release", ".build", "build", "dist", "out", "bin"];
            const breakpointsByName = args.breakpointsByName || [];
            const breakpointLogCommands = args.breakpointLogCommands || ["thread backtrace all", "frame variable"];
            const maxSeconds = args.maxSeconds || 20;
            const attempt = args.attempt || 1;
            const targetOverride = args.targetOverride;

            const buildResult = await runBuildCommands(buildCommands);

            if (buildResult.exitCode !== 0) {
              return JSON.stringify({
                build: buildResult,
                artifact: { chosen: null, candidates: [] },
                lldb: { exitCode: -1, stdout: "", stderr: "Build failed" },
                status: "build-failed",
                breakpointsHit: 0,
                hasCrash: false,
                analysis: { breakpointsTriggered: [] }
              });
            }

            let artifactResult: ArtifactResult;

            if (targetOverride) {
              artifactResult = {
                chosen: targetOverride,
                candidates: [{ path: targetOverride, mtimeMs: Date.now(), reason: "User-specified target" }]
              };
            } else {
              artifactResult = await findNewestExecutable(artifactRoots);
            }

            if (!artifactResult.chosen) {
              return JSON.stringify({
                build: buildResult,
                artifact: artifactResult,
                lldb: { exitCode: -1, stdout: "", stderr: "No executable found" },
                status: "needs-target",
                breakpointsHit: 0,
                hasCrash: false,
                analysis: { breakpointsTriggered: [] }
              });
            }

            const lldbScript = await generateLLDBScript(breakpointsByName, breakpointLogCommands, programArgs);
            const lldbResult = await runLLDB(artifactResult.chosen, lldbScript, maxSeconds);

            const analysis = parseLLDBOutput(lldbResult.stdout + lldbResult.stderr);

            return JSON.stringify({
              build: buildResult,
              artifact: artifactResult,
              lldb: lldbResult,
              status: lldbResult.exitCode === 0 ? "ok" : "lldb-failed",
              breakpointsHit: analysis.breakpointsHit,
              hasCrash: analysis.hasCrash,
              analysis: {
                crashLocation: analysis.crashLocation,
                crashedThread: analysis.crashedThread,
                breakpointsTriggered: analysis.breakpointsTriggered,
                exitReason: analysis.exitReason
              }
            });
          } catch (err) {
            logError("debug_run.execute error", err);
            return JSON.stringify({
              build: { exitCode: -1, stdout: "", stderr: String(err) },
              artifact: { chosen: null, candidates: [] },
              lldb: { exitCode: -1, stdout: "", stderr: String(err) },
              status: "lldb-failed",
              breakpointsHit: 0,
              hasCrash: false,
              analysis: { breakpointsTriggered: [] }
            });
          }
        }
      })
    }
  };
}) satisfies Plugin;
