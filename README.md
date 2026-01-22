# @elitist/opencode-lldb-debug

An OpenCode plugin that enables LLDB-powered debugging with automatic build, artifact detection, and structured crash analysis.

## Installation

### Via npm (Recommended)

```bash
npm install @elitist/opencode-lldb-debug
```

### Configure OpenCode

Add the plugin to your OpenCode configuration file (`~/.config/opencode/config.json`):

```json
{
  "plugins": [
    "@elitist/opencode-lldb-debug"
  ]
}
```

Restart OpenCode after installation.

### Manual Installation

```bash
# Clone or download the repository
git clone https://github.com/elitist/opencode-lldb-debug.git

# Copy plugin files to OpenCode plugins directory
cp -r opencode-lldb-debug/src ~/.config/opencode/plugins/lldb_debug/
cp opencode-lldb-debug/index.ts ~/.config/opencode/plugins/lldb_debug/index.ts
```

## Features

- **Auto-detection** - Automatically activates when you mention debug keywords (debug, crash, breakpoint, segfault, etc.)
- **Smart build** - Infers and runs build commands based on project type (Rust, C++, Node.js, etc.)
- **Executable finder** - Automatically selects the newest executable from common build directories
- **LLDB integration** - Runs LLDB in batch mode with breakpoints and variable inspection
- **Structured output** - Returns parsed results with crash location, thread info, and exit reasons
- **Progressive debugging** - Suggests reruns with additional breakpoints when needed

No separate agent file needed - debug mode is embedded in the plugin!

## Usage

Just ask OpenCode to debug naturally:

```
"debug this program"
"why is my program crashing?"
"set a breakpoint at the login function"
"debug the segfault in main.cpp line 42"
```

The plugin automatically:
1. Detects the debug request
2. Infers build commands from your project structure
3. Builds the project
4. Finds the executable
5. Runs LLDB with appropriate breakpoints
6. Returns structured analysis

### Multi-Artifact Projects

If multiple executables are found:

```
No executable found. Which would you like to debug?

1. ./target/debug/myapp (Executable, mode: 100755)
2. ./target/release/myapp (Executable, mode: 100755)

Or provide a custom path.
```

### Rerun with More Instrumentation

If the initial run is inconclusive, the plugin suggests:

- Add function breakpoints (`breakpointsByName`)
- Add file:line breakpoints (`fileLineBreakpoints`)
- Add variable prints (`expressionPrints`)

## Tool Parameters

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

## Tool Output

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

## How It Works

### 1. Artifact Selection

The plugin automatically finds executables by:

1. Scanning configured directories (depth ≤ 3)
2. Filtering by platform:
   - **macOS/Linux**: Files with executable mode (`mode & 0o111 != 0`), excluding `.a`, `.o`, `.so`, `.dylib`
   - **Windows**: `.exe`, `.cmd`, `.bat` files
3. Sorting by modification time (newest first)
4. Returning top 5 candidates for user selection if ambiguous

### 2. LLDB Script Generation

The plugin generates LLDB scripts like:

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

### 3. Crash Analysis

Automatically detects and parses:
- Crash signals (EXC_BAD_ACCESS, SIGSEGV, SIGABRT, etc.)
- Crash location (function + file:line)
- Crashed thread number
- Exit reason

## Examples

### Example 1: Debug a Rust Program

```
User: "debug this rust program, it's crashing"

OpenCode:
1. Detects "debug" + "crashing"
2. Infers buildCommands: ["cargo build"]
3. Calls debug_run
4. Finds ./target/debug/myapp
5. Runs LLDB
6. Returns crash analysis with stack trace
```

### Example 2: Debug with Specific Breakpoint

```
User: "debug the crash at handle_request function"

OpenCode:
1. Infers buildCommands from project
2. Sets breakpointsByName: ["handle_request"]
3. Runs LLDB
4. Shows variables at breakpoint
5. Continues to crash
6. Shows crash location
```

### Example 3: Rerun with More Details

```
User: "debug but I need to see the value of userID"

OpenCode:
1. Runs debug_run with expressionPrints: ["userID"]
2. Shows userID value at each breakpoint
3. Helps identify the issue
```

## Safety

- All runs enforce `maxSeconds` timeout (default: 20s)
- Partial logs returned on timeout
- Build stops on first failure (early exit)
- Crash detection via signal pattern matching
- Temp files use OS temp directory (auto-cleanup)

## Testing

### Smoke Tests

1. **Single executable project**: Verify build → artifact selection → LLDB run → transcript
2. **Multi-artifact repo**: Verify candidates returned and user selection prompted
3. **Rerun**: Verify attempt 2 adds breakpoints and produces more detailed output
4. **File:line breakpoints**: Test `fileLineBreakpoints: [{file: "main.cpp", line: 42}]`
5. **Expression prints**: Test `expressionPrints: ["myVariable", "pointer->field"]`
6. **Crash location**: Verify `crashLocation` is populated on crashes

## Requirements

- **LLDB** - Must be installed on the system (`lldb --version`)
- **OpenCode** - Latest version with plugin support
- **Node.js** - Version 18 or higher

## License

MIT
