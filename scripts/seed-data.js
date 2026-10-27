/**
 * Enterprise Banking Test Data Pool Synthesizer
 * 
 * Generates realistic segmented customer profiles, card UIDs, credit lines,
 * and balance data into ./data/customers.csv for Artillery CSV payload feeding.
 * 
 * Authored by Aman Patwal (Lead SDET & QA Automation Architect)
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const firstNames = ["Aman", "Liam", "Olivia", "Noah", "Emma", "Oliver", "Charlotte", "Elijah", "Amelia", "James", "Sophia", "William", "Isabella", "Benjamin", "Mia", "Lucas", "Evelyn", "Henry", "Harper", "Alexander"];
const lastNames = ["Patwal", "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson"];
const tiers = ["PLATINUM", "GOLD", "ENTERPRISE", "STANDARD", "PRIME"];
const networks = ["VISA", "MASTERCARD", "AMEX"];

const records = [
  "customerUid,name,tier,cardUid,currentBalance,phone,creditLimit,riskScore,isDelinquent"
];

for (let i = 1; i <= 250; i++) {
  const fName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const lName = lastNames[Math.floor(Math.random() * lastNames.length)];
  const fullName = `${fName} ${lName}`;
  const tier = tiers[Math.floor(Math.random() * tiers.length)];
  const network = networks[Math.floor(Math.random() * networks.length)];
  const customerUid = `usr_${10000 + i}`;
  const cardUid = `cc-${network.toLowerCase()}-${tier.toLowerCase()}-${1000 + i}`;
  
  let creditLimit = 10000;
  if (tier === "PLATINUM" || tier === "ENTERPRISE") creditLimit = 25000 + Math.floor(Math.random() * 25000);
  else if (tier === "GOLD" || tier === "PRIME") creditLimit = 15000 + Math.floor(Math.random() * 10000);

  const isDelinquent = Math.random() < 0.15; // 15% delinquent accounts for settlement testing
  const currentBalance = isDelinquent 
    ? Number((creditLimit * (0.7 + Math.random() * 0.28)).toFixed(2))
    : Number((creditLimit * (0.1 + Math.random() * 0.35)).toFixed(2));

  const riskScore = isDelinquent ? Math.floor(520 + Math.random() * 90) : Math.floor(680 + Math.random() * 150);
  const phone = `+1415555${String(1000 + i).padStart(4, "0")}`;

  records.push(`${customerUid},"${fullName}",${tier},${cardUid},${currentBalance},${phone},${creditLimit},${riskScore},${isDelinquent}`);
}

const csvFilePath = path.join(DATA_DIR, "customers.csv");
fs.writeFileSync(csvFilePath, records.join("\n"), "utf8");

console.log(`✓ Synthesized ${records.length - 1} enterprise banking records into: ${csvFilePath}`);
