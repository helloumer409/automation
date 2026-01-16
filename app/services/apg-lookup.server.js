import ftp from "basic-ftp";
import fs from "fs";
import path from "path";
import unzipper from "unzipper";
import csv from "csv-parser";
import { readAPGCSV } from "./apg-csv.server";

let cachedIndex = null;
let cacheTimestamp = null;
let lastCSVDownloadTime = null;
let lastCSVPath = null;
let csvWasJustDownloaded = false; // Track if CSV was just downloaded in this call
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hour cache for CSV download (APG updates daily)
const INDEX_CACHE_TTL = 1000 * 60 * 60; // 1 hour cache for the index itself

/**
 * Gets the timestamp of the last CSV download
 */
export function getLastCSVDownloadTime() {
  return lastCSVDownloadTime;
}

/**
 * Checks if CSV was just downloaded in the current getAPGIndex call
 */
export function wasCSVJustDownloaded() {
  return csvWasJustDownloaded;
}

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
    
    // Verify file exists and get size
    const stats = fs.statSync(csvPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const fileSizeKB = (stats.size / 1024).toFixed(0);
    console.log(`✅ APG CSV downloaded and verified:`);
    console.log(`   📁 Path: ${csvPath}`);
    console.log(`   📊 Size: ${fileSizeMB} MB (${fileSizeKB} KB)`);
    console.log(`   ⚠️  Note: Railway filesystem is ephemeral - files are cleared on container restart`);

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
        // Handle UPC - convert scientific notation (e.g., 8.34532E+11) to proper number
        let upcRaw = row["Upc"] || row["UPC"] || row["upc"] || "";
        let upc = String(upcRaw).trim();
        
        // Convert scientific notation to full number
        if (upc.includes("E+") || upc.includes("e+") || upc.includes("E-") || upc.includes("e-")) {
          try {
            const numValue = parseFloat(upc);
            upc = Math.round(numValue).toString();
          } catch (e) {
            // Keep original if conversion fails
          }
        }
        
        // Calculate total inventory from all warehouse columns
        const nvWhse = Number(row["NV whse"] || row["NV Whse"] || 0) || 0;
        const kyWhse = Number(row["KY whse"] || row["KY Whse"] || 0) || 0;
        const mfgInvt = Number(row["MFG Invt"] || row["MFG Invt"] || 0) || 0;
        const waWhse = Number(row["WA whse"] || row["WA Whse"] || 0) || 0;
        const warehouseTotal = nvWhse + kyWhse + mfgInvt + waWhse;
        
        // Use "USA Item Availability" column first, fallback to warehouse total
        const usaAvailability = Number(row["USA Item Availability"] || 0) || 0;
        const totalInventory = usaAvailability > 0 ? usaAvailability : warehouseTotal;
        
        // Try multiple possible field names for MAP and Cost
        const mapPrice = row["MAP"] || row["Map"] || row["map"] || row["MAP Price"] || row["MAP Price (USD)"];
        const customerPrice = row["Customer Price"] || row["Customer Price (USD)"] || row["Cost"] || row["cost"] || row["COST"];
        
        // Preserve original row structure for compatibility
        const processedRow = {
          upc: upc,
          premierPartNumber: row["Premier Part Number"]?.trim() || row["Premier Part #"]?.trim(),
          priceMAP: mapPrice,
          inventory: totalInventory,
          // Keep original fields for sync function compatibility
          Upc: upc,
          "Premier Part Number": row["Premier Part Number"]?.trim() || row["Premier Part #"]?.trim(),
          MAP: mapPrice,
          "Customer Price": customerPrice,
          "Customer Price (USD)": customerPrice,
          Cost: customerPrice,
          cost: customerPrice,
          "Mfg Part Number": row["Mfg Part Number"] || row["Manufacturer Part Number"] || row["Mfg Part #"],
          "USA Item Availability": totalInventory, // Use calculated value
          // Warehouse breakdown (for reference)
          "NV whse": nvWhse,
          "KY whse": kyWhse,
          "MFG Invt": mfgInvt,
          "WA whse": waWhse,
          // Keep entire original row for flexibility
          ...row
        };
        results.push(processedRow);
      })
      .on("end", () => {
        console.log(`✅ CSV parsed successfully. Total rows: ${results.length}`);
        if (results.length === 0) {
          console.warn("⚠️ WARNING: CSV file is empty or no data was parsed!");
        } else {
          const sample = results[0];
          console.log("📋 Sample CSV row data:", {
            UPC: sample.Upc || sample.upc || "N/A",
            MAP: sample.MAP || sample.map || "N/A",
            CustomerPrice: sample["Customer Price"] || sample["Customer Price (USD)"] || sample.Cost || "N/A",
            PartNumber: sample["Premier Part Number"] || sample.premierPartNumber || "N/A",
            Inventory: sample.inventory || sample["USA Item Availability"] || "N/A"
          });
          console.log(`✅ CSV data loaded: ${results.length} products ready for sync`);
        }
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
  // Return cached index if still valid (1 hour cache for index)
  if (cachedIndex && cacheTimestamp && (Date.now() - cacheTimestamp) < INDEX_CACHE_TTL) {
    console.log("📦 Using cached APG index");
    return cachedIndex;
  }

  console.log("🔄 Building APG index...");
  let csvData = [];
  csvWasJustDownloaded = false; // Reset flag

  try {
    // Check if we have a recent CSV download (within 24 hours)
    const shouldDownloadCSV = !lastCSVDownloadTime || (Date.now() - lastCSVDownloadTime) >= CACHE_TTL;
    const shouldUseCachedCSV = !shouldDownloadCSV && lastCSVPath && fs.existsSync(lastCSVPath);

    if (shouldUseCachedCSV) {
      // Use cached CSV file (downloaded within last 24 hours)
      const hoursSinceDownload = ((Date.now() - lastCSVDownloadTime) / (1000 * 60 * 60)).toFixed(1);
      console.log(`📦 Using cached CSV file (downloaded ${hoursSinceDownload} hours ago)`);
      console.log(`   Path: ${lastCSVPath}`);
      try {
        csvData = await readAPGCSVFromPath(lastCSVPath);
        console.log(`✅ Successfully loaded ${csvData.length} items from cached CSV`);
      } catch (cacheError) {
        console.warn("⚠️ Cached CSV read failed, will re-download:", cacheError.message);
        // Fall through to download logic
      }
    }

    // Download fresh CSV if needed (24+ hours old or cache read failed)
    if (csvData.length === 0 && process.env.APG_FTP_HOST && process.env.APG_FTP_USERNAME && process.env.APG_FTP_PASSWORD) {
      try {
        console.log("📥 Downloading fresh CSV from FTP (24+ hours since last download)...");
        console.log(`   Host: ${process.env.APG_FTP_HOST}`);
        console.log(`   User: ${process.env.APG_FTP_USERNAME}`);
        console.log(`   File: ${process.env.APG_FTP_FILENAME || "premier_data_feed_master.zip"}`);
        const csvPath = await downloadAndExtractAPGFeed();
        csvData = await readAPGCSVFromPath(csvPath);
        // Cache the download time and path for next time
        const previousDownloadTime = lastCSVDownloadTime;
        lastCSVDownloadTime = Date.now();
        lastCSVPath = csvPath;
        csvWasJustDownloaded = true; // Mark that CSV was just downloaded
        console.log(`✅ Successfully downloaded and loaded ${csvData.length} items from FTP CSV`);
        console.log(`   This CSV will be reused for the next 24 hours`);
        if (previousDownloadTime) {
          const hoursBetween = ((lastCSVDownloadTime - previousDownloadTime) / (1000 * 60 * 60)).toFixed(1);
          console.log(`   Previous CSV was ${hoursBetween} hours old`);
        }
      } catch (ftpError) {
        console.error("❌ FTP download failed:", ftpError.message);
        console.warn("⚠️ Falling back to local CSV (if available)...");
      }
    } else if (csvData.length === 0 && !process.env.APG_FTP_HOST) {
      console.log("ℹ️  FTP credentials not configured, trying local CSV");
    }

    // Priority 3: Try local CSV file (for development)
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

  // Build index: Map by UPC/barcode (handle multiple formats)
  const index = new Map();
  
  for (const item of csvData) {
    const upc = item.Upc || item.upc;
    if (!upc) continue;

    const upcStr = String(upc).trim();
    // Normalize UPC: remove leading zeros (UPC can be 12-14 digits)
    const normalizedUpc = upcStr.replace(/^0+/, "");
    
    // Also pad to common lengths for matching
    const padded12 = normalizedUpc.padStart(12, "0");
    const padded13 = normalizedUpc.padStart(13, "0");
    const padded14 = normalizedUpc.padStart(14, "0");

    // Index by multiple formats for better matching
    const keysToIndex = [
      upcStr,                    // Original format
      normalizedUpc,             // Without leading zeros
      padded12,                  // 12-digit format
      padded13,                  // 13-digit format  
      padded14                   // 14-digit format
    ];

    for (const key of keysToIndex) {
      if (key && !index.has(key)) {
        index.set(key, item);
      }
    }

    // Also index by Premier Part Number and Mfg Part Number if available (for SKU matching)
    const partNumber = item["Premier Part Number"] || item.premierPartNumber;
    if (partNumber) {
      const partNumStr = String(partNumber).trim();
      if (!index.has(partNumStr)) {
        index.set(partNumStr, item);
      }
      // Also index uppercase version for case-insensitive matching
      const partNumUpper = partNumStr.toUpperCase();
      if (partNumUpper !== partNumStr && !index.has(partNumUpper)) {
        index.set(partNumUpper, item);
      }
    }
    
    // Also index by Mfg Part Number for additional matching
    const mfgPartNumber = item["Mfg Part Number"] || item["Manufacturer Part Number"];
    if (mfgPartNumber) {
      const mfgPartStr = String(mfgPartNumber).trim();
      if (!index.has(mfgPartStr)) {
        index.set(mfgPartStr, item);
      }
      // Also index uppercase version
      const mfgPartUpper = mfgPartStr.toUpperCase();
      if (mfgPartUpper !== mfgPartStr && !index.has(mfgPartUpper)) {
        index.set(mfgPartUpper, item);
      }
    }
  }

  // Log sample data for debugging
  if (csvData.length > 0) {
    const sample = csvData[0];
    console.log("📋 Sample CSV row fields:", Object.keys(sample).slice(0, 10).join(", "));
    console.log("📋 Sample data:", {
      UPC: sample.Upc || sample.upc,
      MAP: sample.MAP || sample.map,
      CustomerPrice: sample["Customer Price"] || sample["Customer Price (USD)"] || sample.Cost,
      PartNumber: sample["Premier Part Number"] || sample.premierPartNumber
    });
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
