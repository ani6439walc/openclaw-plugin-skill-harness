import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

function captureStats(stateRoot) {
  const result = { packages: 0, files: 0, logicalBytes: 0 };
  function walk(root) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) {
        result.files++;
        result.logicalBytes += fs.statSync(target).size;
      }
    }
  }
  const root = path.join(stateRoot, "tmp", "plugin-captures");
  if (fs.existsSync(root)) {
    for (const generation of fs.readdirSync(root)) {
      const captures = path.join(root, generation, "captures");
      if (fs.existsSync(captures)) {
        for (const build of fs.readdirSync(captures, { withFileTypes: true })) {
          if (!build.isDirectory()) continue;
          const buildRoot = path.join(captures, build.name);
          // Count the loader's package boundaries, not nested fixture manifests.
          result.packages += fs
            .readdirSync(buildRoot, { withFileTypes: true })
            .filter(
              (entry) =>
                entry.isDirectory() && /^package-\d+$/u.test(entry.name),
            ).length;
        }
        walk(captures);
      }
    }
  }
  return result;
}

async function capacityInInspection(openclawEntry, configPath, stateRoot) {
  const dist = path.join(path.dirname(fs.realpathSync(openclawEntry)), "dist");
  // Resolve the named facade export rather than pinning a release-specific hash
  // or guessing the minified implementation's export alias.
  const candidates = fs.readdirSync(dist).filter((name) => {
    if (!/^status-.*\.mjs$/u.test(name)) return false;
    const source = fs.readFileSync(path.join(dist, name), "utf8");
    return /export\s*\{[^}]*\bwithPluginDiagnosticsReportForInspection\b(?!\s+as\b)/su.test(
      source,
    );
  });
  if (candidates.length !== 1) {
    throw new Error(
      `Unsupported installed OpenClaw: expected one named inspection facade in ${dist}, found ${candidates.length}`,
    );
  }
  const statusModule = path.join(dist, candidates[0]);
  const { withPluginDiagnosticsReportForInspection } = await import(
    pathToFileURL(statusModule).href
  );
  if (typeof withPluginDiagnosticsReportForInspection !== "function") {
    throw new Error(
      `Unsupported installed OpenClaw inspection export: ${statusModule}`,
    );
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const result = await withPluginDiagnosticsReportForInspection(
    {
      config,
      env: process.env,
      runtimeInspection: true,
      onlyPluginIds: ["skill-harness"],
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    },
    (report) => {
      const plugin = report.plugins.find(
        (entry) => entry.id === "skill-harness",
      );
      if (plugin?.status !== "loaded")
        throw new Error("Capacity trial did not load skill-harness");
      // The official inspection owner releases its generation only after this
      // synchronous formatter returns. No polling or partial-tree estimate.
      const capture = captureStats(stateRoot);
      if (capture.packages === 0)
        throw new Error(
          "Inspection formatter has no captured dependency snapshot",
        );
      return {
        phase: "inspection-formatter-before-release",
        statusModule,
        plugin: { id: plugin.id, status: plugin.status },
        ...capture,
      };
    },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function createProfile(outputRoot, name, packageRoot) {
  const root = path.join(outputRoot, name);
  if (fs.existsSync(root))
    throw new Error(`Refusing to reuse profile: ${root}`);
  fs.mkdirSync(path.join(root, "state", "extensions"), { recursive: true });
  fs.mkdirSync(path.join(root, "workspace"));
  fs.mkdirSync(path.join(root, "home"));
  fs.symlinkSync(
    path.resolve(packageRoot),
    path.join(root, "state", "extensions", "skill-harness"),
    "dir",
  );
  const model = {
    model: "benchmark-mock",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "benchmark-placeholder",
  };
  fs.writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({
      agents: { defaults: { workspace: path.join(root, "workspace") } },
      plugins: {
        allow: ["skill-harness"],
        entries: {
          "skill-harness": {
            enabled: true,
            hooks: { allowConversationAccess: true },
            config: { qmd: { embedding: model, expansion: model }, jev: model },
          },
        },
      },
    }),
  );
  // Use a private home as well as a private OpenClaw state directory: personal
  // credentials, skills, compile caches and custom loader flags stay out.
  const env = Object.fromEntries(
    ["PATH", "HOME", "USER", "LANG", "TZ", "SystemRoot"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(env, {
    OPENCLAW_HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "home", ".config"),
    XDG_CACHE_HOME: path.join(root, "home", ".cache"),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
    OPENCLAW_PLUGIN_LIFECYCLE_TRACE: "1",
  });
  return { root, env };
}

async function runChild(profile, args) {
  let stdout;
  let stderr;
  const started = performance.now();
  try {
    stdout = fs.openSync(path.join(profile.root, "inspect.json"), "w");
    stderr = fs.openSync(path.join(profile.root, "trace.log"), "w");
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        env: profile.env,
        stdio: ["ignore", stdout, stderr],
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (signal)
          reject(new Error(`Loader terminated by ${signal}: ${profile.root}`));
        else resolve(code);
      });
    });
    if (code !== 0)
      throw new Error(
        `Loader exited ${code}; see ${path.join(profile.root, "trace.log")}`,
      );
    return performance.now() - started;
  } finally {
    if (stdout !== undefined) fs.closeSync(stdout);
    if (stderr !== undefined) fs.closeSync(stderr);
  }
}

async function capacityTrial(openclawEntry, packageRoot, outputRoot, label) {
  const profile = createProfile(outputRoot, `${label}-capacity`, packageRoot);
  await runChild(profile, [
    scriptPath,
    "--capacity-child",
    path.resolve(openclawEntry),
    path.join(profile.root, "config.json"),
    path.join(profile.root, "state"),
  ]);
  const capacity = JSON.parse(
    fs.readFileSync(path.join(profile.root, "inspect.json"), "utf8"),
  );
  if (
    capacity.phase !== "inspection-formatter-before-release" ||
    capacity.plugin?.status !== "loaded" ||
    !(capacity.packages > 0)
  ) {
    throw new Error(
      `Invalid official inspection capacity result: ${profile.root}`,
    );
  }
  fs.writeFileSync(
    path.join(profile.root, "capture.json"),
    JSON.stringify(capacity, null, 2),
  );
  return capacity;
}

async function main(args) {
  if (args[0] === "--capacity-child") {
    if (args.length !== 4) throw new Error("Invalid capacity child arguments");
    await capacityInInspection(...args.slice(1));
    return;
  }
  // A single isolated capacity probe is useful for validating a new host build
  // without repeating the ten latency subprocesses.
  if (args[0] === "--capacity-only") {
    const [, openclawEntry, packageRoot, output] = args;
    if (args.length !== 4)
      throw new Error(
        "Usage: measure-plugin-loader.mjs --capacity-only OPENCLAW_ENTRY PACKAGE PRIVATE_OUTPUT_DIR",
      );
    const outputRoot = path.resolve(output);
    fs.mkdirSync(outputRoot, { recursive: true });
    console.log(
      JSON.stringify(
        await capacityTrial(openclawEntry, packageRoot, outputRoot, "probe"),
        null,
        2,
      ),
    );
    return;
  }
  const [openclawEntry, baseline, candidate, output] = args;
  if (args.length !== 4)
    throw new Error(
      "Usage: node measure-plugin-loader.mjs OPENCLAW_ENTRY BASELINE_PACKAGE CANDIDATE_PACKAGE PRIVATE_OUTPUT_DIR",
    );
  const outputRoot = path.resolve(output);
  fs.mkdirSync(outputRoot, { recursive: true });
  const builds = [
    ["baseline", baseline],
    ["candidate", candidate],
  ];
  const capacity = {};
  for (const [label, packageRoot] of builds) {
    capacity[label] = await capacityTrial(
      openclawEntry,
      packageRoot,
      outputRoot,
      label,
    );
  }
  const results = [];
  for (let iteration = 0; iteration < 5; iteration++) {
    for (const [label, packageRoot] of builds) {
      const profile = createProfile(
        outputRoot,
        `${label}-${iteration + 1}`,
        packageRoot,
      );
      // Latency trials do not scan captures or poll the child at all.
      const wallMs = await runChild(profile, [
        path.resolve(openclawEntry),
        "plugins",
        "inspect",
        "skill-harness",
        "--runtime",
        "--json",
      ]);
      const inspect = JSON.parse(
        fs.readFileSync(path.join(profile.root, "inspect.json"), "utf8"),
      );
      if (inspect.plugin?.status !== "loaded")
        throw new Error(`Plugin did not load: ${profile.root}`);
      const trace = fs.readFileSync(
        path.join(profile.root, "trace.log"),
        "utf8",
      );
      const phase = [
        ...trace.matchAll(
          /phase="runtime plugin registry load" ms=([\d.]+) status=ok command="inspect"/g,
        ),
      ].at(-1);
      if (!phase)
        throw new Error(`Missing real loader timing: ${profile.root}`);
      results.push({
        label,
        iteration: iteration + 1,
        wallMs,
        loaderMs: Number(phase[1]),
      });
      fs.writeFileSync(
        path.join(outputRoot, "results.json"),
        JSON.stringify(
          {
            node: process.version,
            openclawEntry: path.resolve(openclawEntry),
            capacity,
            results,
          },
          null,
          2,
        ),
      );
      console.log(
        `${label} ${iteration + 1}: loader ${phase[1]} ms; wall ${wallMs.toFixed(2)} ms`,
      );
    }
  }
  for (const [label] of builds) {
    const values = results
      .filter((entry) => entry.label === label)
      .map((entry) => entry.loaderMs)
      .sort((a, b) => a - b);
    console.log(
      `${label}: median ${values[2]} ms; range ${values[0]}–${values[4]} ms`,
    );
  }
}

await main(process.argv.slice(2));
