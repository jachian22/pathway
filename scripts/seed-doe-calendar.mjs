#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import postgres from "postgres";

function parseArgs(argv) {
  const args = {
    file: "data/doe-calendar.seed.csv",
    truncate: false,
    dryRun: false,
    sourceUpdatedAt: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part) continue;

    if (part === "--truncate") {
      args.truncate = true;
      continue;
    }

    if (part === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (part.startsWith("--file=")) {
      args.file = part.slice("--file=".length);
      continue;
    }

    if (part === "--file") {
      args.file = argv[i + 1] ?? args.file;
      i += 1;
      continue;
    }

    if (part.startsWith("--source-updated-at=")) {
      args.sourceUpdatedAt = part.slice("--source-updated-at=".length);
      continue;
    }
  }

  return args;
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const eqIndex = trimmed.indexOf("=");
  if (eqIndex < 1) return null;

  const key = trimmed.slice(0, eqIndex).trim();
  let value = trimmed.slice(eqIndex + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (!(parsed.key in process.env)) {
      process.env[parsed.key] = parsed.value;
    }
  }
}

function parseCsvLine(line) {
  const cols = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      cols.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cols.push(current.trim());
  return cols;
}

function parseSchoolDay(value) {
  const normalized = value.trim().toLowerCase();
  if (["true", "t", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "f", "0", "no", "n"].includes(normalized)) return false;
  throw new Error(`Invalid is_school_day value: "${value}"`);
}

function parseDoeCsv(filePath, sourceUpdatedAtOverride) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (lines.length === 0) {
    throw new Error("CSV is empty.");
  }

  const header = parseCsvLine(lines[0]);
  const indexByName = Object.fromEntries(header.map((name, idx) => [name.trim().toLowerCase(), idx]));
  const required = ["date", "event_type", "is_school_day"];

  for (const key of required) {
    if (indexByName[key] === undefined) {
      throw new Error(`Missing required CSV column: ${key}`);
    }
  }

  const rows = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const date = cols[indexByName.date] ?? "";
    const eventType = cols[indexByName.event_type] ?? "";
    const isSchoolDayRaw = cols[indexByName.is_school_day] ?? "";
    const sourceUpdatedAt =
      sourceUpdatedAtOverride ??
      (indexByName.source_updated_at !== undefined ? cols[indexByName.source_updated_at] : "");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Row ${i + 1}: invalid date "${date}" (expected YYYY-MM-DD)`);
    }

    if (eventType.trim().length === 0) {
      throw new Error(`Row ${i + 1}: event_type cannot be empty`);
    }

    const parsedSchoolDay = parseSchoolDay(isSchoolDayRaw);
    const parsedUpdatedAt = sourceUpdatedAt ? new Date(sourceUpdatedAt) : null;
    if (sourceUpdatedAt && Number.isNaN(parsedUpdatedAt?.getTime())) {
      throw new Error(`Row ${i + 1}: invalid source_updated_at "${sourceUpdatedAt}"`);
    }

    rows.push({
      calendarDate: date,
      eventType: eventType.trim(),
      isSchoolDay: parsedSchoolDay,
      sourceUpdatedAt: parsedUpdatedAt ? parsedUpdatedAt.toISOString() : null,
    });
  }

  return rows;
}

async function main() {
  const cwd = process.cwd();
  loadEnvFile(path.join(cwd, ".env.local"));
  loadEnvFile(path.join(cwd, ".env"));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is missing. Set it in your environment or .env.local/.env.");
  }

  const args = parseArgs(process.argv.slice(2));
  const csvPath = path.isAbsolute(args.file) ? args.file : path.join(cwd, args.file);
  if (!fs.existsSync(csvPath)) {
    throw new Error(`DOE CSV file not found: ${csvPath}`);
  }

  const rows = parseDoeCsv(csvPath, args.sourceUpdatedAt);
  if (rows.length === 0) {
    throw new Error("No DOE rows parsed from CSV.");
  }

  if (args.dryRun) {
    console.log(`Parsed ${rows.length} DOE rows from ${csvPath}`);
    console.log(`First row: ${JSON.stringify(rows[0], null, 2)}`);
    return;
  }

  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await sql.begin(async (tx) => {
      if (args.truncate) {
        await tx`truncate table "pathway_doe_calendar_days"`;
      }

      for (const row of rows) {
        await tx`
          insert into "pathway_doe_calendar_days"
          ("calendarDate", "eventType", "isSchoolDay", "sourceUpdatedAt", "meta", "updatedAt")
          values (
            ${row.calendarDate},
            ${row.eventType},
            ${row.isSchoolDay},
            ${row.sourceUpdatedAt},
            ${tx.json({
              ingested_by: "scripts/seed-doe-calendar.mjs",
              ingested_from: path.basename(csvPath),
            })},
            now()
          )
          on conflict ("calendarDate")
          do update set
            "eventType" = excluded."eventType",
            "isSchoolDay" = excluded."isSchoolDay",
            "sourceUpdatedAt" = excluded."sourceUpdatedAt",
            "meta" = excluded."meta",
            "updatedAt" = now()
        `;
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  console.log(
    `Upserted ${rows.length} DOE calendar rows into pathway_doe_calendar_days from ${csvPath}`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`DOE seed failed: ${message}`);
  process.exit(1);
});
