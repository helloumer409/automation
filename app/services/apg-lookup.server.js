import ftp from "basic-ftp";
import fs from "fs";
import path from "path";
import unzipper from "unzipper";
import csv from "csv-parser";
import { readAPGCSV } from "./apg-csv.server";

let cachedIndex = null;
let cacheTimestamp = null;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour cache

/**
 * Downloads and extracts APG feed from FTP
 * @returns {Promise<string>} Path to extracted CSV file
 */
export async function downloadAndExtractAPGFeed() {
  const client = new ftp.Client();
  client.ftp.verbose = true;

  // Use system temp directory - works on both local and Railway
  const tmpDir = process.env.TMPDIR || process.env.TMP || "/tmp";
  const apgDir = path.join(tmpDir, "apg");
  const zipPath = path.join(apgDir, "premier_data_feed_master.zip");

  try {
    // Ensure temp dir exists
    fs.mkdirSync(apgDir, { recursive: true });

    const ftpFilename = process.env.APG_FTP_FILENAME || "premier_data_feed_master.zip";

    await client.access({
      host: process.env.APG_FTP_HOST,
      user: process.env.APG_FTP_USERNAME,
      password: process.env.APG_FTP_PASSWORD,
      port: Number(process.env.APG_FTP_PORT || 21),
      secure: false,
    });

    console.log("📥 Downloading APG feed from FTP...");
    // Download ZIP
    await client.downloadTo(zipPath, ftpFilename);
    console.log("✅ APG ZIP downloaded:", zipPath);

    // Extract ZIP
    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: apgDir }))
      .promise();

    console.log("✅ APG ZIP extracted to:", apgDir);

    // Find CSV file dynamically
    const files = fs.readdirSync(apgDir);
    const csvFile = files.find(f => f.endsWith(".csv"));

    if (!csvFile) {
      throw new Error("CSV file not found after extraction");
    }

    const csvPath = path.join(apgDir, csvFile);
    console.log("✅ APG CSV ready:", csvPath);

    return csvPath;
  } catch (err) {
    console.error("❌ APG FTP ERROR:", err);
    throw err;
  } finally {
    client.close();
  }
}

/**
 * Reads CSV from a specific file path
 */
async function readAPGCSVFromPath(csvPath) {
  const results = [];

  return new Promise((resolve, reject) => {
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on("data", (row) => {
        // Calculate total inventory from all warehouse columns
        const nvWhse = Number(row["NV whse"] || 0) || 0;
        const kyWhse = Number(row["KY whse"] || 0) || 0;
        const mfgInvt = Number(row["MFG Invt"] || 0) || 0;
        const waWhse = Number(row["WA whse"] || 0) || 0;
        const totalInventory = nvWhse + kyWhse + mfgInvt + waWhse;
        
        // Preserve original row structure for compatibility
        const processedRow = {
          upc: row["Upc"]?.trim(),
          premierPartNumber: row["Premier Part Number"]?.trim(),
          priceMAP: row["MAP"],
          inventory: totalInventory,
          // Keep original fields for sync function compatibility
          Upc: row["Upc"]?.trim(),
          "Premier Part Number": row["Premier Part Number"]?.trim(),
          MAP: row["MAP"],
          "Customer Price": row["Customer Price"] || row["Customer Price (USD)"] || row["Cost"],
          "Mfg Part Number": row["Mfg Part Number"] || row["Manufacturer Part Number"],
          "USA Item Availability": totalInventory,
          // Warehouse breakdown
          "NV whse": nvWhse,
          "KY whse": kyWhse,
          "MFG Invt": mfgInvt,
          "WA whse": waWhse,
          // Keep entire original row
          ...row
        };
        results.push(processedRow);
      })
      .on("end", () => {
        console.log("✅ CSV parsed. Total rows:", results.length);
        resolve(results);
      })
      .on("error", reject);
  });
}

/**
 * Creates an index (Map) of APG data by UPC/barcode for fast lookups
 * @returns {Promise<Map>} Map indexed by UPC/barcode
 */
export async function getAPGIndex() {
  // Return cached index if still valid
  if (cachedIndex && cacheTimestamp && (Date.now() - cacheTimestamp) < CACHE_TTL) {
    console.log("📦 Using cached APG index");
    return cachedIndex;
  }

  console.log("🔄 Building APG index...");
  let csvData = [];

  try {
    // Priority 1: Try downloading from FTP (for production/Railway)
    if (process.env.APG_FTP_HOST && process.env.APG_FTP_USERNAME && process.env.APG_FTP_PASSWORD) {
      try {
        console.log("📥 Attempting to download CSV from FTP...");
        const csvPath = await downloadAndExtractAPGFeed();
        csvData = await readAPGCSVFromPath(csvPath);
        console.log(`✅ Loaded ${csvData.length} items from FTP CSV`);
      } catch (ftpError) {
        console.warn("⚠️ FTP download failed, trying local CSV:", ftpError.message);
      }
    }

    // Priority 2: Try local CSV file (for development)
    if (csvData.length === 0) {
      try {
        csvData = await readAPGCSV();
        console.log(`✅ Loaded ${csvData.length} items from local CSV`);
      } catch (localError) {
        console.error("❌ Local CSV not found:", localError.message);
        throw new Error("Unable to load APG data. Please ensure FTP credentials are configured or CSV file exists.");
      }
    }
  } catch (error) {
    console.error("❌ Failed to load APG data:", error);
    throw error;
  }

  // Build index: Map by UPC/barcode (both normalized and original)
  const index = new Map();
  
  for (const item of csvData) {
    const upc = item.Upc || item.upc;
    if (!upc) continue;

    const upcStr = String(upc).trim();
    const normalizedUpc = upcStr.replace(/^0+/, ""); // Remove leading zeros

    // Index by original UPC
    if (!index.has(upcStr)) {
      index.set(upcStr, item);
    }

    // Index by normalized UPC (if different)
    if (normalizedUpc !== upcStr && !index.has(normalizedUpc)) {
      index.set(normalizedUpc, item);
    }

    // Also index by Premier Part Number if available
    const partNumber = item["Premier Part Number"] || item.premierPartNumber;
    if (partNumber && !index.has(String(partNumber).trim())) {
      index.set(String(partNumber).trim(), item);
    }
  }

  console.log(`✅ APG index built with ${index.size} entries from ${csvData.length} items`);
  
  // Cache the index
  cachedIndex = index;
  cacheTimestamp = Date.now();

  return index;
}

/**
 * Clears the APG index cache
 */
export function clearAPGIndexCache() {
  cachedIndex = null;
  cacheTimestamp = null;
  console.log("🗑️ APG index cache cleared");
}
