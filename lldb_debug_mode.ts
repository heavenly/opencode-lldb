import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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

interface FileLineBreakpoint {
  file: string;
  line: number;
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

    try {
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
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ exitCode: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      }
    }
  });
}

async function runBuildCommands(commands: string[]): Promise<BuildResult> {
  if (commands.length === 0) {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  let combinedStdout = "";
  let combinedStderr = "";

  for (const cmd of commands) {
    logError(`Running build command: ${cmd}`);
    try {
      const result = await execCommand(cmd);
      combinedStdout += `> ${cmd}\n${result.stdout}\n`;
      combinedStderr += `> ${cmd}\n${result.stderr}\n`;
      
      // Stop on first failure
      if (result.exitCode !== 0) {
        return { exitCode: result.exitCode, stdout: combinedStdout, stderr: combinedStderr };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      combinedStderr += `> ${cmd}\nError: ${errMsg}\n`;
      return { exitCode: -1, stdout: combinedStdout, stderr: combinedStderr };
    }
  }

  return { exitCode: 0, stdout: combinedStdout, stderr: combinedStderr };
}

async function findNewestExecutable(artifactRoots: string[]): Promise<ArtifactResult> {
  const candidates: ArtifactCandidate[] = [];
  const maxDepth = 3;

  async function scanDirectory(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await scanDirectory(fullPath, depth + 1);
        } else if (entry.isFile()) {
          try {
            const stats = await fs.promises.stat(fullPath);
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
              if (mode !== 0 && !entry.name.endsWith(".a") && !entry.name.endsWith(".o") && !entry.name.endsWith(".so") && !entry.name.endsWith(".dylib")) {
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
  fileLineBreakpoints: FileLineBreakpoint[],
  expressionPrints: string[],
  breakpointLogCommands: string[],
  programArgs: string[]
): Promise<string> {
  let script = `settings set auto-confirm true\n`;
  script += `settings set target.stop-on-sharedlibrary-events false\n\n`;

  let breakpointId = 1;

  // Add function/symbol breakpoints
  for (const symbol of breakpointsByName) {
    script += `breakpoint set --name "${symbol}"\n`;
    script += `breakpoint command add ${breakpointId}\n`;
    
    // Add custom log commands (no duplication - these ARE the commands)
    for (const cmd of breakpointLogCommands) {
      script += `${cmd}\n`;
    }
    
    // Add expression prints
    for (const expr of expressionPrints) {
      script += `expr -- ${expr}\n`;
    }
    
    script += `process continue\n`;
    script += `DONE\n\n`;
    breakpointId++;
  }

  // Add file:line breakpoints
  for (const bp of fileLineBreakpoints) {
    script += `breakpoint set --file "${bp.file}" --line ${bp.line}\n`;
    script += `breakpoint command add ${breakpointId}\n`;
    
    for (const cmd of breakpointLogCommands) {
      script += `${cmd}\n`;
    }
    
    for (const expr of expressionPrints) {
      script += `expr -- ${expr}\n`;
    }
    
    script += `process continue\n`;
    script += `DONE\n\n`;
    breakpointId++;
  }

  // Set program arguments
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
  const tempScriptPath = path.join(os.tmpdir(), `lldb_script_${Date.now()}.txt`);

  try {
    await fs.promises.writeFile(tempScriptPath, script);

    const timeoutMs = maxSeconds * 1000;
    const cmd = `lldb --batch -s "${tempScriptPath}" "${target}"`;
    const result = await execCommand(cmd, timeoutMs);

    return result;
  } catch (err) {
    logError("runLLDB error", err);
    return { exitCode: -1, stdout: "", stderr: String(err) };
  } finally {
    try {
      await fs.promises.unlink(tempScriptPath);
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

  const crashPatterns = [
    /EXC_BAD_ACCESS|EXC_CRASH|SIGABRT|SIGSEGV|SIGILL/,
    /Program terminated with signal/,
    /Process \d+ stopped/,
    /Thread \d+ crashed/
  ];

  for (const pattern of crashPatterns) {
    if (pattern.test(output)) {
      result.hasCrash = true;
      break;
    }
  }

  // Extract crash location
  if (result.hasCrash) {
    const crashLocationMatch = output.match(/frame #0:.*`([^`]+)`.*at ([^:]+):(\d+)/);
    if (crashLocationMatch) {
      result.crashLocation = `${crashLocationMatch[1]} at ${crashLocationMatch[2]}:${crashLocationMatch[3]}`;
    } else {
      const simpleLocationMatch = output.match(/at ([^:]+):(\d+)/);
      if (simpleLocationMatch) {
        result.crashLocation = `${simpleLocationMatch[1]}:${simpleLocationMatch[2]}`;
      }
    }
  }

  const threadBacktraceMatch = output.match(/thread #(\d+)[,\s]/);
  if (threadBacktraceMatch) {
    result.crashedThread = parseInt(threadBacktraceMatch[1], 10);
  }

  const breakpointMatches = output.match(/Breakpoint \d+ hit/gi);
  result.breakpointsHit = breakpointMatches ? breakpointMatches.length : 0;

  const breakpointNameRegex = /Breakpoint \d+: where = .*`([^`]+)`/gi;
  let match;
  while ((match = breakpointNameRegex.exec(output)) !== null) {
    result.breakpointsTriggered.push(match[1].trim());
  }

  const exitReasonMatch = output.match(/Process \d+ (exited with|terminated with|detached from) (.+?)[\n\r]/i);
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
          fileLineBreakpoints: tool.schema.array(
            tool.schema.object({
              file: tool.schema.string(),
              line: tool.schema.number()
            })
          ).optional().default([]),
          expressionPrints: tool.schema.array(tool.schema.string()).optional().default([]),
          breakpointLogCommands: tool.schema.array(tool.schema.string()).optional().default(["thread backtrace all", "frame variable"]),
          maxSeconds: tool.schema.number().optional().default(20),
          attempt: tool.schema.number().optional().default(1),
          targetOverride: tool.schema.string().optional()
        },
        async execute(args) {
          logError("debug_run.execute called", `attempt ${args.attempt}`);

          try {
            const buildResult = await runBuildCommands(args.buildCommands);

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

            if (args.targetOverride) {
              artifactResult = {
                chosen: args.targetOverride,
                candidates: [{ path: args.targetOverride, mtimeMs: Date.now(), reason: "User-specified target" }]
              };
            } else {
              artifactResult = await findNewestExecutable(args.artifactRoots);
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

            const lldbScript = await generateLLDBScript(
              args.breakpointsByName,
              args.fileLineBreakpoints,
              args.expressionPrints,
              args.breakpointLogCommands,
              args.programArgs
            );
            
            logError("Running LLDB", artifactResult.chosen);
            const lldbResult = await runLLDB(artifactResult.chosen, lldbScript, args.maxSeconds);

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
    },
    hooks: {
      "tool.execute.after": async (input, output) => {
        // Hook to observe debug_run results and suggest reruns
        if (input.tool === "debug_run") {
          try {
            const result = JSON.parse(output.output);
            
            // If no breakpoints hit and no crash, suggest rerun
            if (result.breakpointsHit === 0 && !result.hasCrash && result.status === "ok") {
              logError("Debug run inconclusive", "no breakpoints hit");
            }
            
            // If crash with no location, suggest more instrumentation
            if (result.hasCrash && !result.analysis?.crashLocation) {
              logError("Crash detected", "no location extracted");
            }
          } catch {
            // Invalid JSON, ignore
          }
        }
      }
    }
  };
}) satisfies Plugin;
