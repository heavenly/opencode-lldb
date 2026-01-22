# LLDB Debug Mode for OpenCode

An OpenCode plugin + agent that enables LLDB-powered debugging with automatic build, artifact detection, and structured output.

## Overview

This project provides a complete debugging workflow for OpenCode:

1. **Plugin** (`.opencode/plugins/lldb_debug_mode.ts`) - Provides the `debug_run` tool
2. **Agent** (`.opencode/agent/debug.md`) - Auto-detects debug requests and orchestrates the workflow

## Files

| File | Location | Purpose |
|------|----------|---------|
| `lldb_debug_mode.ts` | `.opencode/plugins/` | Plugin providing the `debug_run` tool |
| `debug.md` | `.opencode/agent/` | Agent that detects debug requests and calls the tool |

## Plugin: lldb_debug_mode.ts

**Location:** `.opencode/plugins/lldb_debug_mode.ts`

The plugin registers the `debug_run` tool which:

- Executes LLM-chosen build commands
- Auto-selects the newest executable from common directories
- Runs LLDB in batch mode with configurable breakpoints
- Returns structured output with crash detection

### Tool Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `buildCommands` | `string[]` | - | Shell commands to build the project (required) |
| `programArgs` | `string[]` | `[]` | Arguments passed to the executable |
| `artifactRoots` | `string[]` | `["target/debug", "target/release", ".build", "build", "dist", "out", "bin"]` | Directories to search for executables |
| `breakpointsByName` | `string[]` | `[]` | Function/symbol names to set breakpoints on |
| `fileLineBreakpoints` | `Array<{file: string, line: number}>` | `[]` | File:line breakpoints for specific locations |
| `expressionPrints` | `string[]` | `[]` | Variable expressions to print at breakpoints |
| `breakpointLogCommands` | `string[]` | `["thread backtrace all", "frame variable"]` | Commands run when breakpoint hits |
| `maxSeconds` | `number` | `20` | Timeout in seconds (safety limit) |
| `attempt` | `number` | `1` | Rerun counter for progressive debugging |
| `targetOverride` | `string` | - | Manual executable path (bypass auto-detection) |

### Tool Output

```typescript
{
  build: { exitCode: number; stdout: string; stderr: string },
  artifact: { chosen: string | null; candidates: Array<{ path: string; mtimeMs: number; reason: string }> },
  lldb: { exitCode: number; stdout: string; stderr: string },
  status: "ok" | "needs-target" | "build-failed" | "lldb-failed",
  breakpointsHit: number,
  hasCrash: boolean,
  analysis: {
    crashLocation?: string;
    crashedThread?: number;
    breakpointsTriggered: string[];
    exitReason?: string;
  }
}
```

## Agent: debug.md

**Location:** `.opencode/agent/debug.md`

The agent automatically triggers when the user asks to debug something. It:

1. Detects debug keywords in user prompts ("debug", "crash", "breakpoint", etc.)
2. Calls `debug_run` with inferred build commands and breakpoints
3. Analyzes results and determines if more instrumentation is needed
4. Proposes rerun options with additional breakpoints/prints
5. Asks user approval before any code edits for fallback instrumentation

### Supported Debug Keywords

- debug, debugging, debugger
- breakpoint, breakpoints
- lldb
- crash, segmentation fault, assertion failed

### Workflow

1. **Initial Debug Run**
   - Infer build commands (npm run build, cargo build, make, etc.)
   - Infer relevant breakpoints from the issue description
   - Call `debug_run` with attempt=1

2. **Handle Results**
   - If `status === "needs-target"`: Present artifact candidates, ask user to select
   - If `status === "build-failed"`: Analyze build errors, propose fixes
   - If `status === "lldb-failed"`: Analyze LLDB errors, suggest parameter adjustments
   - If `status === "ok"`: Analyze crash points, stack traces, assertion failures

3. **Rerun Policy**
   If the run is inconclusive:
   - Option A: Add function breakpoints (`breakpointsByName`)
   - Option B: Add file:line breakpoints (`fileLineBreakpoints`)
   - Option C: Add variable prints (`expressionPrints`)
   - Option D: Run without breakpoints

   Present options and get user approval before rerunning.

4. **Instrumentation Fallback** (User-Approved Only)
   - Describe exactly what code changes will be made
   - Get explicit user approval with "Yes, make these changes"
   - Run debug again with instrumentation
   - Clean up instrumentation when done

## Installation

### Step 1: Install Plugin

```bash
# Create the plugins directory if it doesn't exist
mkdir -p .opencode/plugins

# Copy the plugin file
cp lldb_debug_mode.ts .opencode/plugins/
```

### Step 2: Install Agent (Optional - for auto-detection)

```bash
# Create the agent directory if it doesn't exist
mkdir -p .opencode/agent

# Copy the agent template
cp debug.md .opencode/agent/
```

### Step 3: Restart OpenCode

OpenCode automatically loads plugins and agents from `.opencode/` on startup.

## Usage

### Basic

User: "debug this program"

Agent detects the request → calls `debug_run` → returns structured results

### With Specifics

User: "debug the crash in the login function"

Agent infers breakpoints for "login" → runs debug → shows crash location and stack trace

### Multi-Artifact Projects

If multiple executables are found, the agent presents candidates:

```
No executable found. Which would you like to debug?

1. ./target/debug/myapp (Executable)
2. ./target/release/myapp (Executable)

Or provide a custom path.
```

## Artifact Selection

The plugin automatically finds executables by:

1. Scanning configured directories (depth ≤ 3)
2. Filtering by platform:
   - **macOS/Linux**: Files with executable mode (`mode & 0o111 != 0`), excluding `.a`, `.o`, `.so`, `.dylib`
   - **Windows**: `.exe`, `.cmd`, `.bat` files
3. Sorting by modification time (newest first)
4. Returning top 5 candidates for user selection if ambiguous

## LLDB Script Generation

The plugin generates LLDB scripts with:

```lldb
settings set auto-confirm true
settings set target.stop-on-sharedlibrary-events false

# Function breakpoints
breakpoint set --name "function_name"
breakpoint command add 1
  thread backtrace all
  frame variable
  expr -- variable_name
  process continue
  DONE

# File:line breakpoints
breakpoint set --file "main.cpp" --line 42
breakpoint command add 2
  thread backtrace all
  frame variable
  expr -- some_variable
  process continue
  DONE

run
process status
thread backtrace all
quit
```

## Error Logging

Errors are logged to `error.log` in the project directory with timestamps:

```
[2026-01-21T10:30:00.000Z] debug_run.execute called: {"buildCommands":["npm run build"]}
[2026-01-21T10:30:01.500Z] Running build command: npm run build
[2026-01-21T10:30:05.200Z] Running LLDB on: ./target/debug/myapp
```

## Testing

### Smoke Tests

1. **Single executable project**: Verify build → artifact selection → LLDB run → transcript
2. **Multi-artifact repo**: Verify candidates returned and user selection prompted
3. **Rerun**: Verify attempt 2 adds breakpoints and produces more detailed output
4. **File:line breakpoints**: Test `fileLineBreakpoints: [{file: "main.cpp", line: 42}]`
5. **Expression prints**: Test `expressionPrints: ["myVariable", "pointer->field"]`
6. **Crash location**: Verify `crashLocation` is populated on crashes

### Safety

- All runs enforce `maxSeconds` timeout (default: 20s)
- Partial logs returned on timeout
- Build stops on first failure (early exit)
- Crash detection via signal pattern matching
- Temp files use OS temp directory (auto-cleanup)

## Requirements

- **LLDB** - Must be installed on the system (`lldb --version`)
- **OpenCode** - Latest version with plugin support
- **Node.js/Bun** - For running the TypeScript plugin

## File Structure

```
opencode-lldb/
├── README.md                    # This file
├── FIXES.md                     # Detailed changelog of corrections
├── plan.md                      # Original implementation plan
├── debug.md                     # Agent template (copy to .opencode/agent/)
├── lldb_debug_mode.ts           # Source plugin file
├── .opencode/
│   ├── plugins/
│   │   └── lldb_debug_mode.ts   # Copy for OpenCode to load
│   ├── agent/                   # (Create this directory)
│   │   └── debug.md             # Agent for auto-detection
│   ├── package.json             # Dependencies (@opencode-ai/plugin)
│   └── error.log                # Generated on errors
```

## Creating debug.md Agent

Create `.opencode/agent/debug.md` with this template:

See `debug.md` in the repository root for the complete agent template.

Quick start:
```bash
cp debug.md .opencode/agent/
```

The agent template includes:
- Automatic keyword detection (debug, crash, breakpoint, etc.)
- Build command inference based on project type
- Structured rerun proposals with concrete parameter suggestions
- User approval workflow for instrumentation fallback
```

## License

MIT
