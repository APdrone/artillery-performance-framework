/**
 * Enterprise FinTech Banking Microservices Core Engine & Mock Gateway
 * 
 * Production-grade simulation of tier-1 banking architecture including:
 * 1. OAuth2 / JWT Authentication & Scoped RBAC Validation
 * 2. Idempotency Key Engine (Transaction replay deduplication)
 * 3. Database Connection Pooling & Exhaustion Simulation
 * 4. Optimistic Concurrency Control (ETag / If-Match version conflict detection)
 * 5. Token Bucket Rate Limiting (X-RateLimit headers & 429 throttling)
 * 6. Chaos Engineering Injections (Latency spikes, 500 fault injection, connection resets)
 * 7. Real-Time Financial WebSocket Feed (Transaction streaming & ledger alerts)
 * 8. Prometheus Telemetry Endpoint (/metrics)
 * 9. Comprehensive Core Banking APIs (Credit cards, underwriting settlements, ledgers)
 * 
 * Authored by Aman Patwal (Lead SDET & QA Automation Architect)
 */

const http = require("http");
const url = require("url");
const crypto = require("crypto");
let WebSocket;
try {
  WebSocket = require("ws");
} catch (e) {
  WebSocket = null;
}

const PORT = parseInt(process.env.PORT || "8088", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_LATENCY_MS = parseInt(process.env.SIMULATED_LATENCY_MS || "12", 10);
const DB_POOL_CAPACITY = parseInt(process.env.DB_POOL_CAPACITY || "40", 10);

// ==============================================================================
// 1. STATE MANAGEMENT & IN-MEMORY REPOSITORIES
// ==============================================================================

const memoryStore = {
  activeDbConnections: 0,
  waitingDbQueue: 0,
  idempotencyCache: new Map(), // key -> { response, timestamp }
  rateLimitBuckets: new Map(), // ip -> { tokens, lastRefill }
  metrics: {
    requestsTotal: 0,
    requestsByStatus: { 200: 0, 201: 0, 400: 0, 401: 0, 403: 0, 404: 0, 409: 0, 429: 0, 500: 0, 503: 0 },
    idempotencyHits: 0,
    rateLimitHits: 0,
    poolExhaustions: 0,
    chaosInjected: 0,
    wsSubscribers: 0,
    latencies: []
  },
  accounts: new Map([
    ["cc-visa-platinum-9901", {
      cardUid: "cc-visa-platinum-9901",
      customerUid: "usr_94821",
      maskedPan: "4111-XXXX-XXXX-8921",
      network: "VISA",
      tier: "PLATINUM",
      status: "ACTIVE",
      creditLimit: 25000.00,
      currentBalance: 6550.00,
      availableCredit: 18450.00,
      version: 1,
      isDelinquent: false
    }],
    ["cc-mastercard-gold-8821", {
      cardUid: "cc-mastercard-gold-8821",
      customerUid: "usr_58219",
      maskedPan: "5424-XXXX-XXXX-3109",
      network: "MASTERCARD",
      tier: "GOLD",
      status: "ACTIVE",
      creditLimit: 15000.00,
      currentBalance: 3200.00,
      availableCredit: 11800.00,
      version: 1,
      isDelinquent: false
    }],
    ["cc-amex-delinquent-7712", {
      cardUid: "cc-amex-delinquent-7712",
      customerUid: "usr_10293",
      maskedPan: "3782-XXXX-XXXX-1029",
      network: "AMEX",
      tier: "STANDARD",
      status: "COLLECTIONS",
      creditLimit: 10000.00,
      currentBalance: 9450.00,
      availableCredit: 550.00,
      version: 3,
      isDelinquent: true
    }]
  ]),
  profiles: [
    { id: "usr_94821", name: "Aman Patwal", tier: "PLATINUM", status: "ACTIVE", creditLimit: 25000, riskScore: 810 },
    { id: "usr_58219", name: "Sarah Jenkins", tier: "GOLD", status: "ACTIVE", creditLimit: 15000, riskScore: 745 },
    { id: "usr_10293", name: "Marcus Vance", tier: "ENTERPRISE", status: "COLLECTIONS", creditLimit: 10000, riskScore: 590 }
  ],
  transactions: [
    { id: "tx_901", cardUid: "cc-visa-platinum-9901", amount: 142.50, merchant: "Amazon Cloud AWS", category: "CLOUD_HOSTING", status: "SETTLED", date: "2026-10-25T14:22:00Z" },
    { id: "tx_902", cardUid: "cc-visa-platinum-9901", amount: 89.20, merchant: "Whole Foods Market", category: "GROCERIES", status: "SETTLED", date: "2026-10-26T09:12:00Z" },
    { id: "tx_903", cardUid: "cc-mastercard-gold-8821", amount: 1250.00, merchant: "Delta Air Lines", category: "TRAVEL", status: "SETTLED", date: "2026-10-26T18:40:00Z" }
  ]
};

// ==============================================================================
// 2. HELPER UTILITIES: AUTH, IDEMPOTENCY, RATE LIMITING, DB POOL
// ==============================================================================

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({ raw: body });
      }
    });
  });
}

function verifyAuth(req) {
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) {
    return { authenticated: false, error: "MISSING_BEARER_TOKEN" };
  }
  const token = authHeader.substring(7).trim();
  if (token === "expired_token_mock_123") {
    return { authenticated: false, error: "TOKEN_EXPIRED" };
  }
  if (!token || token === "invalid") {
    return { authenticated: false, error: "INVALID_TOKEN_SIGNATURE" };
  }
  return {
    authenticated: true,
    user: "api_client_fintech_runner",
    scopes: ["cards:read", "cards:write", "settlement:underwrite", "admin:all"]
  };
}

function checkRateLimit(ip) {
  const now = Date.now();
  const maxTokens = 200; // Capacity
  const refillRate = 100; // Tokens per second
  let bucket = memoryStore.rateLimitBuckets.get(ip);

  if (!bucket) {
    bucket = { tokens: maxTokens, lastRefill: now };
    memoryStore.rateLimitBuckets.set(ip, bucket);
  } else {
    const elapsedSeconds = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsedSeconds * refillRate);
    bucket.lastRefill = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens), limit: maxTokens };
  }
  memoryStore.metrics.rateLimitHits++;
  return { allowed: false, remaining: 0, limit: maxTokens, retryAfter: 1 };
}

function acquireDbConnection() {
  return new Promise((resolve, reject) => {
    if (memoryStore.activeDbConnections < DB_POOL_CAPACITY) {
      memoryStore.activeDbConnections++;
      return resolve(() => {
        memoryStore.activeDbConnections = Math.max(0, memoryStore.activeDbConnections - 1);
      });
    }

    // Queue wait
    memoryStore.waitingDbQueue++;
    const timeout = setTimeout(() => {
      memoryStore.waitingDbQueue = Math.max(0, memoryStore.waitingDbQueue - 1);
      memoryStore.metrics.poolExhaustions++;
      reject(new Error("DB_CONNECTION_POOL_TIMEOUT"));
    }, 120);

    const checkInterval = setInterval(() => {
      if (memoryStore.activeDbConnections < DB_POOL_CAPACITY) {
        clearInterval(checkInterval);
        clearTimeout(timeout);
        memoryStore.waitingDbQueue = Math.max(0, memoryStore.waitingDbQueue - 1);
        memoryStore.activeDbConnections++;
        resolve(() => {
          memoryStore.activeDbConnections = Math.max(0, memoryStore.activeDbConnections - 1);
        });
      }
    }, 10);
  });
}

function sendJsonResponse(res, statusCode, data, headers = {}) {
  const payload = JSON.stringify(data);
  memoryStore.metrics.requestsTotal++;
  memoryStore.metrics.requestsByStatus[statusCode] = (memoryStore.metrics.requestsByStatus[statusCode] || 0) + 1;

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "X-Server-Engine": "FinTech-Core-Banking-Engine/v3.0",
    "X-Correlation-ID": headers["X-Correlation-ID"] || `corr-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Correlation-ID, Idempotency-Key, If-Match, X-Chaos-Mode",
    ...headers
  });
  res.end(payload);
}

// ==============================================================================
// 3. CORE HTTP DISPATCHER & ROUTER
// ==============================================================================

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();
  const clientIp = req.socket.remoteAddress || "127.0.0.1";

  // Handle CORS
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Correlation-ID, Idempotency-Key, If-Match, X-Chaos-Mode"
    });
    return res.end();
  }

  // Rate Limiting Check
  const rateLimit = checkRateLimit(clientIp);
  const rateLimitHeaders = {
    "X-RateLimit-Limit": rateLimit.limit,
    "X-RateLimit-Remaining": rateLimit.remaining,
    "X-RateLimit-Reset": "1"
  };

  if (!rateLimit.allowed && pathname !== "/healthz" && pathname !== "/metrics") {
    return sendJsonResponse(res, 429, {
      error: "RATE_LIMIT_EXCEEDED",
      message: "Client request rate quota reached. Apply exponential backoff."
    }, { ...rateLimitHeaders, "Retry-After": "1" });
  }

  // Chaos Engineering Injections
  const chaosHeader = req.headers["x-chaos-mode"] || "";
  if (chaosHeader) {
    memoryStore.metrics.chaosInjected++;
    if (chaosHeader === "latency-spike") {
      await new Promise(r => setTimeout(r, 650));
    } else if (chaosHeader === "internal-error") {
      return sendJsonResponse(res, 500, {
        error: "CHAOS_INJECTED_500",
        message: "Simulated critical database dead-lock or downstream timeout."
      }, rateLimitHeaders);
    } else if (chaosHeader === "rate-limit") {
      return sendJsonResponse(res, 429, {
        error: "CHAOS_INJECTED_429",
        message: "Simulated token bucket threshold exhaustion."
      }, rateLimitHeaders);
    }
  }

  // 1. Telemetry / Health Checks (Zero Auth / Zero DB required)
  if (pathname === "/healthz" || pathname === "/health") {
    return sendJsonResponse(res, 200, {
      status: "HEALTHY",
      service: "enterprise-fintech-core",
      uptime: process.uptime(),
      dbConnections: {
        active: memoryStore.activeDbConnections,
        waiting: memoryStore.waitingDbQueue,
        capacity: DB_POOL_CAPACITY
      },
      wsSubscribers: memoryStore.metrics.wsSubscribers,
      timestamp: new Date().toISOString()
    }, rateLimitHeaders);
  }

  // 2. Prometheus OpenMetrics Endpoint
  if (pathname === "/metrics") {
    const lines = [
      "# HELP http_requests_total Total HTTP requests received",
      "# TYPE http_requests_total counter",
      `http_requests_total ${memoryStore.metrics.requestsTotal}`,
      "# HELP http_requests_by_status Total HTTP requests partitioned by status code",
      "# TYPE http_requests_by_status counter"
    ];
    for (const [code, count] of Object.entries(memoryStore.metrics.requestsByStatus)) {
      lines.push(`http_requests_by_status{code="${code}"} ${count}`);
    }
    lines.push(
      "# HELP db_active_connections Current active simulated database connection leases",
      "# TYPE db_active_connections gauge",
      `db_active_connections ${memoryStore.activeDbConnections}`,
      "# HELP db_waiting_queue Pending queries queued for connection lease",
      "# TYPE db_waiting_queue gauge",
      `db_waiting_queue ${memoryStore.waitingDbQueue}`,
      "# HELP idempotent_replays_total Total requests served directly from Idempotency cache",
      "# TYPE idempotent_replays_total counter",
      `idempotent_replays_total ${memoryStore.metrics.idempotencyHits}`,
      "# HELP rate_limit_throttled_total Total 429 rate limit throttled events",
      "# TYPE rate_limit_throttled_total counter",
      `rate_limit_throttled_total ${memoryStore.metrics.rateLimitHits}`
    );
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    return res.end(lines.join("\n"));
  }

  // 3. OAuth2 Token Provisioning Endpoint
  if (pathname === "/api/v1/auth/token" && method === "POST") {
    const body = await parseJsonBody(req);
    const clientId = body.clientId || "client_fintech_runner";
    const token = `jwt_live_${crypto.randomBytes(16).toString("hex")}`;
    const refreshToken = `rf_${crypto.randomBytes(16).toString("hex")}`;

    return sendJsonResponse(res, 200, {
      success: true,
      tokenType: "Bearer",
      accessToken: token,
      refreshToken: refreshToken,
      expiresInSeconds: 900,
      scope: ["cards:read", "cards:write", "settlement:underwrite", "admin:all"],
      issuedAt: new Date().toISOString()
    }, rateLimitHeaders);
  }

  // Auth Verification Guard for all remaining /api/v1 routes
  const auth = verifyAuth(req);
  if (!auth.authenticated) {
    return sendJsonResponse(res, 401, {
      error: "UNAUTHORIZED",
      message: `Authentication failed: ${auth.error}. Provide a valid Bearer token via Authorization header.`
    }, rateLimitHeaders);
  }

  // Idempotency Key Handling for Mutations
  const idempotencyKey = req.headers["idempotency-key"] || req.headers["x-idempotency-key"];
  if (method === "POST" && idempotencyKey) {
    if (memoryStore.idempotencyCache.has(idempotencyKey)) {
      memoryStore.metrics.idempotencyHits++;
      const cached = memoryStore.idempotencyCache.get(idempotencyKey);
      return sendJsonResponse(res, cached.statusCode, cached.data, {
        ...rateLimitHeaders,
        "X-Idempotency-Replay": "true",
        "X-Cache-Lookup": "HIT"
      });
    }
  }

  // Acquire simulated DB connection lease
  let releaseDbConnection;
  try {
    releaseDbConnection = await acquireDbConnection();
  } catch (err) {
    return sendJsonResponse(res, 503, {
      error: "DB_CONNECTION_POOL_EXHAUSTED",
      message: "Database connection saturation reached. Concurrency limit breached.",
      activeConnections: memoryStore.activeDbConnections,
      capacity: DB_POOL_CAPACITY
    }, rateLimitHeaders);
  }

  // Simulate realistic DB I/O latency
  await new Promise(r => setTimeout(r, BASE_LATENCY_MS + Math.floor(Math.random() * 8)));

  try {
    // --------------------------------------------------------------------------
    // Route: Profiles
    // --------------------------------------------------------------------------
    if (pathname === "/api/v1/profiles") {
      if (method === "GET") {
        return sendJsonResponse(res, 200, {
          success: true,
          count: memoryStore.profiles.length,
          data: memoryStore.profiles
        }, rateLimitHeaders);
      }
      if (method === "POST") {
        const body = await parseJsonBody(req);
        const newProfile = {
          id: `usr_${Math.floor(10000 + Math.random() * 90000)}`,
          name: body.name || "Test Subject",
          tier: body.tier || "STANDARD",
          status: "ACTIVE",
          creditLimit: body.requestedCreditLimit || 15000,
          riskScore: Math.floor(650 + Math.random() * 150),
          createdAt: new Date().toISOString()
        };
        memoryStore.profiles.push(newProfile);
        const respData = { success: true, profile: newProfile };
        if (idempotencyKey) memoryStore.idempotencyCache.set(idempotencyKey, { statusCode: 201, data: respData });
        return sendJsonResponse(res, 201, respData, rateLimitHeaders);
      }
    }

    // --------------------------------------------------------------------------
    // Route: Credit Card by UID (with Optimistic Lock ETag)
    // --------------------------------------------------------------------------
    if (pathname.startsWith("/api/v1/credit-card")) {
      const cardUid = pathname.split("/").pop();
      const account = memoryStore.accounts.get(cardUid) || {
        cardUid: cardUid,
        customerUid: "usr_dynamic_vu",
        maskedPan: "4111-XXXX-XXXX-9844",
        network: "VISA",
        tier: "PLATINUM",
        status: "ACTIVE",
        creditLimit: 25000.00,
        currentBalance: 5420.00,
        availableCredit: 19580.00,
        version: 1,
        isDelinquent: false
      };

      const etag = `"v${account.version}"`;
      return sendJsonResponse(res, 200, {
        success: true,
        account: account
      }, { ...rateLimitHeaders, "ETag": etag });
    }

    // --------------------------------------------------------------------------
    // Route: Activation Details
    // --------------------------------------------------------------------------
    if (pathname === "/api/v1/activation-details") {
      const body = await parseJsonBody(req);
      const respData = {
        success: true,
        activationStatus: "COMPLETED",
        referenceId: `act-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
        verifiedChannels: ["SMS_OTP", "EMAIL_2FA"],
        activationDate: new Date().toISOString(),
        cardUid: body.cardUid || "cc-default",
        securityChecksum: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").substring(0, 16)
      };
      if (idempotencyKey) memoryStore.idempotencyCache.set(idempotencyKey, { statusCode: 200, data: respData });
      return sendJsonResponse(res, 200, respData, rateLimitHeaders);
    }

    // --------------------------------------------------------------------------
    // Route: Transactions Total & Ledger
    // --------------------------------------------------------------------------
    if (pathname === "/api/v1/transactions-total") {
      const totalVolume = memoryStore.transactions.reduce((acc, tx) => acc + tx.amount, 0);
      return sendJsonResponse(res, 200, {
        success: true,
        aggregate: {
          totalCount: memoryStore.transactions.length,
          totalVolumeUSD: Number(totalVolume.toFixed(2)),
          currency: "USD",
          settledCount: memoryStore.transactions.filter(t => t.status === "SETTLED").length,
          pendingCount: memoryStore.transactions.filter(t => t.status !== "SETTLED").length
        },
        recentLedgerRecords: memoryStore.transactions.slice(-5)
      }, rateLimitHeaders);
    }

    // --------------------------------------------------------------------------
    // Route: Close Eligibility (Checks ETag Versioning)
    // --------------------------------------------------------------------------
    if (pathname === "/api/v1/close-eligibility") {
      const ifMatch = req.headers["if-match"];
      const body = await parseJsonBody(req);
      const cardUid = body.creditCardUid || "cc-visa-platinum-9901";
      const account = memoryStore.accounts.get(cardUid);

      if (account && ifMatch && ifMatch !== `"v${account.version}"`) {
        return sendJsonResponse(res, 409, {
          error: "OPTIMISTIC_LOCK_CONFLICT",
          message: `Resource version mismatch. Requested version: ${ifMatch}, current: "v${account.version}"`
        }, rateLimitHeaders);
      }

      const respData = {
        success: true,
        cardUid: cardUid,
        isEligibleForClosure: true,
        outstandingBalance: 0.00,
        pendingFeeWaivers: true,
        clearingAccountRequired: false,
        validationChecklist: {
          zeroBalanceConfirmed: true,
          noActiveDisputes: true,
          rewardsPointsForfeitedConsent: true
        }
      };
      return sendJsonResponse(res, 200, respData, rateLimitHeaders);
    }

    // --------------------------------------------------------------------------
    // Route: Post-Conversion Statement
    // --------------------------------------------------------------------------
    if (pathname === "/api/v1/post-conversion-statement") {
      return sendJsonResponse(res, 200, {
        success: true,
        statementId: `stmt-conv-${Date.now()}`,
        cycle: "2026-Q3",
        openingBalance: 12500.00,
        closingBalance: 12100.00,
        totalInterestBilled: 0.00,
        statementPdfUrl: "https://vault.internal.bank/statements/stmt-conv-9812.pdf"
      }, rateLimitHeaders);
    }

    // --------------------------------------------------------------------------
    // Route: Phone Textability & Carrier Verification
    // --------------------------------------------------------------------------
    if (pathname === "/api/v1/get-phone-textability") {
      const phone = parsedUrl.query.phone || "+14155552671";
      return sendJsonResponse(res, 200, {
        success: true,
        phone: phone,
        textable: true,
        carrier: "Verizon Wireless",
        lineType: "MOBILE",
        dncOptOut: false
      }, rateLimitHeaders);
    }

    // --------------------------------------------------------------------------
    // Route: Closed Account Letters
    // --------------------------------------------------------------------------
    if (pathname === "/api/v1/closed-account-letters") {
      const body = await parseJsonBody(req);
      const respData = {
        success: true,
        letterId: `ltr-closed-${Date.now()}`,
        dispatchMethod: "ELECTRONIC_SECURE_MAIL",
        estimatedDelivery: "INSTANT",
        accountReference: body.creditCardUid || "cc-ref-unknown",
        approvingOfficer: body.approvingOfficer || "manager"
      };
      if (idempotencyKey) memoryStore.idempotencyCache.set(idempotencyKey, { statusCode: 200, data: respData });
      return sendJsonResponse(res, 200, respData, rateLimitHeaders);
    }

    // --------------------------------------------------------------------------
    // Route: Pay-Off Demand Letter
    // --------------------------------------------------------------------------
    if (pathname === "/api/v1/pay-off-letter") {
      const body = await parseJsonBody(req);
      const respData = {
        success: true,
        letterId: `ltr-payoff-${Date.now()}`,
        validUntil: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        principalPayoff: body.settlementAmount || 3420.50,
        accruedPerDiemInterest: 0.00,
        approvedBy: body.title || "manager"
      };
      if (idempotencyKey) memoryStore.idempotencyCache.set(idempotencyKey, { statusCode: 200, data: respData });
      return sendJsonResponse(res, 200, respData, rateLimitHeaders);
    }

    // --------------------------------------------------------------------------
    // Route: Line of Credit Re-Booking Eligibility
    // --------------------------------------------------------------------------
    if (pathname === "/api/v1/rebok-eligibility") {
      return sendJsonResponse(res, 200, {
        success: true,
        rebokEligible: true,
        tierRecommendation: "TIER_A_PRIME",
        maximumLineOfCredit: 45000,
        underwritingScore: 785
      }, rateLimitHeaders);
    }

    // --------------------------------------------------------------------------
    // Route: Debt Settlement Underwriting Engine (Mutating Financial Core)
    // --------------------------------------------------------------------------
    if (pathname === "/api/v1/get-settlement") {
      const body = await parseJsonBody(req);
      const currentBalance = parseFloat(body.currentBalance) || 5000;
      const settlementAmount = parseFloat(body.settlementAmount) || (currentBalance * 0.5);

      // Invariant Check
      if (settlementAmount > currentBalance) {
        return sendJsonResponse(res, 400, {
          error: "INVALID_SETTLEMENT_FIGURES",
          message: "Settlement amount cannot exceed current account balance."
        }, rateLimitHeaders);
      }

      // Check account mutability and update version
      const cardUid = body.creditCardUid;
      if (cardUid && memoryStore.accounts.has(cardUid)) {
        const account = memoryStore.accounts.get(cardUid);
        account.version++;
        account.currentBalance = Math.max(0, account.currentBalance - settlementAmount);
      }

      const respData = {
        success: true,
        settlementId: `stl-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
        settlementType: body.settlementType || "LUMP_SUM",
        originalBalance: currentBalance,
        agreedSettlementAmount: settlementAmount,
        discountPercentage: body.settlementPercentage || Math.round((1 - settlementAmount / currentBalance) * 100),
        matchPayContributed: body.matchPayAmount || 0,
        status: "APPROVED_UNDERWRITING",
        signoffExecutive: body.title || "director",
        authorizedAt: new Date().toISOString()
      };

      if (idempotencyKey) {
        memoryStore.idempotencyCache.set(idempotencyKey, { statusCode: 200, data: respData });
      }

      return sendJsonResponse(res, 200, respData, rateLimitHeaders);
    }

    // Fallback 404
    return sendJsonResponse(res, 404, {
      error: "ENDPOINT_NOT_FOUND",
      message: `Endpoint ${method} ${pathname} not found on FinTech Mock Engine.`
    }, rateLimitHeaders);

  } finally {
    if (releaseDbConnection) releaseDbConnection();
    const duration = Date.now() - startTime;
    memoryStore.metrics.latencies.push(duration);
    if (memoryStore.metrics.latencies.length > 500) memoryStore.metrics.latencies.shift();
  }
});

// ==============================================================================
// 4. REAL-TIME FINANCIAL WEBSOCKET SERVER
// ==============================================================================

let wss = null;
if (WebSocket) {
  wss = new WebSocket.Server({ noServer: true });

  wss.on("connection", (ws, req) => {
    memoryStore.metrics.wsSubscribers++;
    ws.send(JSON.stringify({
      type: "CONNECTION_ESTABLISHED",
      stream: "fintech_transaction_ticker",
      connectedAt: new Date().toISOString(),
      activeSubscribers: memoryStore.metrics.wsSubscribers
    }));

    // Broadcast heartbeat ticker
    const tickerInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        const fakeAmount = Number((Math.random() * 450 + 10).toFixed(2));
        ws.send(JSON.stringify({
          type: "LEDGER_TRANSACTION_STREAM",
          event: "CARD_CHARGE_SETTLED",
          data: {
            txId: `tx_${Date.now()}`,
            amount: fakeAmount,
            currency: "USD",
            merchant: ["Amazon", "Uber", "Stripe Checkout", "Apple Store"][Math.floor(Math.random() * 4)],
            timestamp: new Date().toISOString()
          }
        }));
      }
    }, 1500);

    ws.on("close", () => {
      clearInterval(tickerInterval);
      memoryStore.metrics.wsSubscribers = Math.max(0, memoryStore.metrics.wsSubscribers - 1);
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;
    if (pathname === "/ws/transactions" || pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });
}

// ==============================================================================
// 5. SERVER BOOTSTRAP
// ==============================================================================

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`========================================================================`);
    console.log(`🏦 SCRIPTCRUX FINTECH CORE BANKING GATEWAY ONLINE`);
    console.log(`📡 URL: http://${HOST}:${PORT}`);
    console.log(`🔒 Health Check: http://localhost:${PORT}/healthz`);
    console.log(`📊 Prometheus Metrics: http://localhost:${PORT}/metrics`);
    if (WebSocket) console.log(`⚡ WebSocket Stream: ws://localhost:${PORT}/ws/transactions`);
    console.log(`⚡ Features: OAuth2 JWT, Idempotency, DB Pool (40), Rate Limiting, Chaos`);
    console.log(`========================================================================`);
  });
}

module.exports = server;
