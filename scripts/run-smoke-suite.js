/**
 * Turnkey Smoke Suite Runner with Autonomous Mock Server Lifecycle
 * 
 * Executes enterprise banking scenarios, verifies SLA quality gates,
 * and compiles interactive HTML performance dashboards.
 * 
 * Authored by Aman Patwal (Lead SDET & QA Automation Architect)
 */

const { spawn, execSync } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { compileAllReports } = require("./generate-reports");

const PORT = 8088;
const REPORT_DIR = path.join(__dirname, "..", "report");

if (!fs.existsSync(REPORT_DIR)) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

function checkServerReady(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const req = http.get(`http://localhost:${PORT}/healthz`, (res) => {
        if (res.statusCode === 200) {
          clearInterval(interval);
          resolve(true);
        }
      });
      req.on("error", () => {
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(interval);
          resolve(false);
        }
      });
    }, 200);
  });
}

async function main() {
  console.log("================================================================================");
  console.log("🚀 SCRIPTCRUX / ENTERPRISE FINTECH PERFORMANCE & RESILIENCE ENGINE");
  console.log("================================================================================");

  let mockProcess = null;
  const isAlreadyRunning = await checkServerReady(800);

  if (!isAlreadyRunning) {
    console.log("📡 Initializing Enterprise FinTech Core Gateway on port 8088...");
    const serverPath = path.join(__dirname, "..", "support", "mock-server.js");
    mockProcess = spawn(process.execPath, [serverPath], {
      stdio: "ignore",
      detached: false
    });
    const ready = await checkServerReady(5000);
    if (!ready) {
      console.error("❌ Failed to bind FinTech Banking Mock Gateway.");
      process.exit(1);
    }
    console.log("✅ FinTech Banking Core Gateway is healthy.");
  } else {
    console.log("✅ Connected to running FinTech Banking Core Gateway on port 8088.");
  }

  const testSuites = [
    { name: "end-to-end-banking-journey", desc: "Complete 7-Step Authenticated Banking & Settlement Journey" },
    { name: "idempotency-and-race-conditions", desc: "Idempotency Key Deduplication & Network Replay" },
    { name: "profiles", desc: "Customer Profile & KYC Ingestion" },
    { name: "creditCardUid", desc: "Credit Card UID & Balance Verification" },
    { name: "get-settlement", desc: "Debt Settlement Underwriting Engine" },
    { name: "websocket-ledger-stream", desc: "Real-Time WebSocket Transaction Stream" }
  ];

  console.log("\n🧪 Executing Enterprise FinTech Performance & Concurrency Scenarios...");
  console.log("--------------------------------------------------------------------------------");

  let allPassed = true;

  for (const item of testSuites) {
    const jsonReport = path.join(REPORT_DIR, `qa1_smoke_${item.name}.json`);
    const configFile = path.join(__dirname, "..", "config", "qa1", `${item.name}.yml`);
    const scenarioFile = path.join(__dirname, "..", "scenarios", `${item.name}.yml`);

    console.log(`▶ Executing: ${item.desc} [${item.name}]...`);
    const cmd = `npx artillery run -e smoke --output "${jsonReport}" --config "${configFile}" "${scenarioFile}"`;

    try {
      execSync(cmd, { stdio: "pipe", cwd: path.join(__dirname, "..") });
      console.log(`  ✓ PASSED: ${item.name} completed successfully.`);
    } catch (err) {
      console.error(`  ✗ FAILED: ${item.name}`);
      if (err.stdout) console.error(err.stdout.toString());
      allPassed = false;
    }
  }

  console.log("\n📊 Compiling Interactive HTML Performance Dashboards...");
  compileAllReports();

  if (mockProcess) {
    mockProcess.kill();
    console.log("\n🛑 Stopped background FinTech Mock Gateway.");
  }

  console.log("================================================================================");
  if (allPassed) {
    console.log("🎉 ALL ENTERPRISE PERFORMANCE GATES PASSED (100% RELIABILITY)");
    console.log(`📂 Dashboards and JSON telemetry saved in: ${REPORT_DIR}`);
    process.exit(0);
  } else {
    console.error("❌ ONE OR MORE SMOKE CHECKS FAILED");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error running smoke suite:", err);
  process.exit(1);
});
