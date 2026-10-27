/**
 * Artillery End-to-End Performance Framework - FinTech Scenario Processor & Helper
 * 
 * Provides dynamic data generation, session parameterization, and request hook processors
 * for enterprise banking, credit card, and settlement load testing workflows.
 * 
 * Features:
 * - Dynamic generation of credit card pseudo-UIDs and settlement mathematics
 * - Cryptographically random UUIDv4 Idempotency-Key injection
 * - Dual-signature lifecycle handling (supports both scenario `function:` and `beforeRequest:` hooks)
 * - Safe zero-dependency fallbacks if lodash/randomstring are absent
 * - Chaos mode header injection for fault-tolerance verification
 * 
 * Authored by Aman Patwal (Lead SDET & QA Automation Architect)
 */

const crypto = require("crypto");

let _;
try {
  _ = require("lodash");
} catch (e) {
  _ = {
    sample: (arr) => arr[Math.floor(Math.random() * arr.length)]
  };
}

let randomstring;
try {
  randomstring = require("randomstring");
} catch (e) {
  randomstring = {
    generate: (opts) => {
      const length = typeof opts === "number" ? opts : (opts && opts.length ? opts.length : 8);
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      let res = "";
      for (let i = 0; i < length; i++) {
        res += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return res;
    }
  };
}

/**
 * Domain Reference Values
 */
const approvingManagers = ["manager", "director", "svp", "vp_operations", "head_of_underwriting"];
const settlementTypes = ["INSTALLMENT", "LUMP_SUM", "STRUCTURED_DEFERRAL"];

function formatDateForLetter(inputDate) {
  if (!inputDate || typeof inputDate !== "string") {
    return new Date().toISOString().split("T")[0];
  }
  const parts = inputDate.split("/");
  if (parts.length < 3) {
    return new Date().toISOString().split("T")[0];
  }
  const month = parts[0].padStart(2, "0");
  const day = parts[1].padStart(2, "0");
  const year = parts[2];
  return `${year}-${month}-${day}`;
}

function printStatus(requestParams, response, context, ee, next) {
  const done = typeof next === "function" ? next : (typeof ee === "function" ? ee : () => {});
  try {
    if (process.env.DEBUG_ARTILLERY === "true" && response) {
      const corrId = response.headers["x-correlation-id"] || "none";
      const etag = response.headers["etag"] || "none";
      console.log(`[HTTP ${response.statusCode}] ${requestParams ? requestParams.url : "URL"} | Corr: ${corrId} | ETag: ${etag}`);
    }
  } catch (err) {}
  return done();
}

function generateAlphabeticString(length = 8) {
  return randomstring.generate({ length, charset: "alphabetic" });
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max, decimals = 2) {
  const val = Math.random() * (max - min) + min;
  return Number(val.toFixed(decimals));
}

function generateSettlementNumbers(overrideBalance = null) {
  const currentBalance = overrideBalance ? parseFloat(overrideBalance) : randomFloat(250, 15000, 2);
  const settlementPercentage = randomInt(20, 80);
  const settlementAmount = Number(((settlementPercentage / 100) * currentBalance).toFixed(2));
  const matchPayAmount = Number((Math.random() < 0.25 ? 0 : randomFloat(0, settlementAmount * 0.35, 2)).toFixed(2));

  return {
    currentBalance,
    settlementPercentage,
    settlementAmount,
    matchPayAmount,
  };
}

/**
 * Processor: Populates dynamic variables before scenario execution
 * Supports both scenario `function:` and `beforeRequest:` hooks.
 */
function setRequestParams(arg1, arg2, arg3, arg4) {
  let context, next, requestParams;

  if (arg1 && arg1.vars) {
    context = arg1;
    next = typeof arg3 === "function" ? arg3 : (typeof arg2 === "function" ? arg2 : () => {});
  } else if (arg2 && arg2.vars) {
    requestParams = arg1;
    context = arg2;
    next = typeof arg4 === "function" ? arg4 : (typeof arg3 === "function" ? arg3 : () => {});
  } else {
    context = { vars: {} };
    next = typeof arg3 === "function" ? arg3 : (typeof arg2 === "function" ? arg2 : () => {});
  }

  if (!context.vars) context.vars = {};

  // Mock domain authority metadata
  context.vars["title"] = _.sample(approvingManagers);
  context.vars["name"] = context.vars["name"] || `Client-${generateAlphabeticString(6)}`;
  context.vars["customerRepresentativeName"] = `Agent-${generateAlphabeticString(6)}`;
  context.vars["settlementType"] = _.sample(settlementTypes);

  // Formatted date values
  const now = new Date();
  const localeDate = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}`;
  context.vars["monthDayYearDate"] = localeDate;
  context.vars["date"] = formatDateForLetter(localeDate);

  // Financial calculations
  const balanceParam = context.vars["currentBalance"] || null;
  const numbers = generateSettlementNumbers(balanceParam);
  context.vars["currentBalance"] = numbers.currentBalance;
  context.vars["settlementAmount"] = numbers.settlementAmount;
  context.vars["settlementPercentage"] = numbers.settlementPercentage;
  context.vars["matchPayAmount"] = numbers.matchPayAmount;

  // Credit Card UID
  if (!context.vars["creditCardUid"]) {
    context.vars["creditCardUid"] = context.vars["cardUid"] || `cc-visa-platinum-${randomInt(1000, 9999)}`;
  }

  // Idempotency Key (UUIDv4)
  context.vars["idempotencyKey"] = crypto.randomUUID();

  // If requestParams is present, inject tracing headers
  if (requestParams) {
    if (!requestParams.headers) requestParams.headers = {};
    requestParams.headers["X-Correlation-ID"] = `art-${Date.now()}-${randomInt(1000, 9999)}`;
    requestParams.headers["User-Agent"] = "Artillery-Enterprise-Runner/v2.0";
    if (context.vars["authToken"]) {
      requestParams.headers["Authorization"] = `Bearer ${context.vars["authToken"]}`;
    }
  }

  return next();
}

/**
 * Pre-request hook: Injects Idempotency-Key and Bearer Auth token
 */
function prepareFinancialMutation(requestParams, context, ee, next) {
  if (!requestParams.headers) requestParams.headers = {};
  if (!context.vars.idempotencyKey) {
    context.vars.idempotencyKey = crypto.randomUUID();
  }
  requestParams.headers["Idempotency-Key"] = context.vars.idempotencyKey;
  requestParams.headers["X-Correlation-ID"] = `art-mut-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  return next();
}

/**
 * Pre-request hook: Injects Chaos mode headers for fault tolerance tests
 */
function injectChaosMode(requestParams, context, ee, next) {
  if (!requestParams.headers) requestParams.headers = {};
  const modes = ["latency-spike", "internal-error", "rate-limit"];
  if (Math.random() < 0.35) {
    requestParams.headers["X-Chaos-Mode"] = _.sample(modes);
  }
  return next();
}

module.exports = {
  formatDateForLetter,
  printStatus,
  generateAlphabeticString,
  randomInt,
  randomFloat,
  generateSettlementNumbers,
  setRequestParams,
  prepareFinancialMutation,
  injectChaosMode,
};
