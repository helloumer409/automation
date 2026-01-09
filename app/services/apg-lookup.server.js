import { readAPGCSV } from "./apg-csv.server.js";
import { fetchAPGInventory, clearAPICache } from "./apg-api.server.js";

let apgIndex = null;

export function clearAPGIndex() {
  apgIndex = null;
  clearAPICache();
  console.log("🗑️ APG index cache cleared");
}

export async function getAPGIndex(useAPI = true) {
  if (apgIndex) return apgIndex;

  let rows = [];
  
  // Try API first if enabled, fallback to CSV
  if (useAPI && process.env.APG_USE_API !== "false") {
    try {
      console.log("📡 Attempting to fetch data from API...");
      rows = await fetchAPGInventory();
    } catch (error) {
      console.warn("⚠️ API fetch failed, falling back to CSV:", error.message);
      useAPI = false;
    }
  }
  
  // Fallback to CSV if API failed or disabled
  if (!useAPI || rows.length === 0) {
    console.log("📄 Using CSV file as data source...");
    rows = await readAPGCSV();
  }
  apgIndex = new Map();

  for (const row of rows) {
    const upc = row.Upc || row.upc;
    const mfg = row["Mfg Part Number"] || row["Manufacturer Part Number"];

    if (upc) {
      // Normalize UPC: remove leading zeros and trim
      const normalizedUpc = String(upc).replace(/^0+/, "").trim();
      if (normalizedUpc) {
        apgIndex.set(normalizedUpc, row);
        // Also store with original leading zeros for matching flexibility
        const originalUpc = String(upc).trim();
        if (originalUpc && originalUpc !== normalizedUpc) {
          apgIndex.set(originalUpc, row);
        }
      }
    }

    if (mfg) {
      const mfgNormalized = String(mfg).trim();
      if (mfgNormalized) {
        apgIndex.set(mfgNormalized, row);
      }
    }
  }

  console.log("✅ APG index ready:", apgIndex.size, "entries");
  
  // Log sample of what's in the index for debugging
  if (apgIndex.size > 0) {
    const sampleKey = Array.from(apgIndex.keys())[0];
    const sampleValue = apgIndex.get(sampleKey);
    console.log("📝 Sample entry - Key:", sampleKey, "MAP:", sampleValue?.MAP || sampleValue?.map || sampleValue?.priceMAP);
  }
  
  return apgIndex;
}
