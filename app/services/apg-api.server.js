/**
 * APG API Service
 * Fetches product inventory and pricing data directly from APG API
 */

const APG_API_BASE_URL = process.env.APG_API_BASE_URL || "https://api.premierwd.com/api/v1";
const APG_API_KEY = process.env.APG_API_KEY || "3720887b-7625-43ec-a57e-62ddbf3edf64";

let apiCache = null;
let cacheTimestamp = null;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour cache

/**
 * Fetches inventory data from APG API
 * @returns {Promise<Array>} Array of product data objects
 */
export async function fetchAPGInventory() {
  // Return cached data if still valid
  if (apiCache && cacheTimestamp && (Date.now() - cacheTimestamp) < CACHE_TTL) {
    console.log("📦 Using cached API data");
    return apiCache;
  }

  try {
    console.log("🔄 Fetching data from APG API...");
    
    // Try common API endpoints
    const endpoints = [
      "/inventory",
      "/products/inventory",
      "/inventory/all",
      "/products",
      "/datafeed"
    ];

    let data = null;
    let lastError = null;

    for (const endpoint of endpoints) {
      try {
        const url = `${APG_API_BASE_URL}${endpoint}`;
        console.log(`📡 Trying endpoint: ${url}`);

        const response = await fetch(url, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${APG_API_KEY}`,
            "X-API-Key": APG_API_KEY,
            "Accept": "application/json",
            "Content-Type": "application/json",
          },
        });

        if (response.ok) {
          data = await response.json();
          console.log(`✅ Successfully fetched from ${endpoint}`);
          break;
        } else if (response.status !== 404) {
          console.warn(`⚠️ Endpoint ${endpoint} returned status ${response.status}`);
          lastError = `Status ${response.status}`;
        }
      } catch (error) {
        console.warn(`⚠️ Error trying ${endpoint}:`, error.message);
        lastError = error.message;
        continue;
      }
    }

    if (!data) {
      throw new Error(`API fetch failed. Last error: ${lastError || "No successful endpoint found"}. Please configure APG_API_BASE_URL environment variable with the correct API endpoint.`);
    }

    // Normalize API response to match CSV structure
    const normalizedData = normalizeAPIData(data);
    
    // Cache the result
    apiCache = normalizedData;
    cacheTimestamp = Date.now();
    
    console.log(`✅ API data fetched and normalized. Total items: ${normalizedData.length}`);
    return normalizedData;
  } catch (error) {
    console.error("❌ API fetch error:", error);
    throw error;
  }
}

/**
 * Normalizes API response data to match CSV row structure
 * Handles different possible API response formats
 */
function normalizeAPIData(apiResponse) {
  // If response is already an array of items
  if (Array.isArray(apiResponse)) {
    return apiResponse.map(normalizeItem);
  }

  // If response has a data property (common API pattern)
  if (apiResponse.data && Array.isArray(apiResponse.data)) {
    return apiResponse.data.map(normalizeItem);
  }

  // If response has products/inventory property
  if (apiResponse.products && Array.isArray(apiResponse.products)) {
    return apiResponse.products.map(normalizeItem);
  }

  if (apiResponse.inventory && Array.isArray(apiResponse.inventory)) {
    return apiResponse.inventory.map(normalizeItem);
  }

  // If response has items property
  if (apiResponse.items && Array.isArray(apiResponse.items)) {
    return apiResponse.items.map(normalizeItem);
  }

  console.warn("⚠️ Unknown API response structure:", Object.keys(apiResponse));
  return [];
}

/**
 * Normalizes a single item to match CSV row format
 */
function normalizeItem(item) {
  return {
    // Original fields preserved
    ...item,
    
    // Standardized field names for compatibility
    Upc: item.Upc || item.upc || item.UPC || item.barcode || item.Barcode,
    "Premier Part Number": item["Premier Part Number"] || item.premierPartNumber || item.partNumber || item.sku,
    MAP: item.MAP || item.map || item.priceMAP || item.mapPrice || item.price,
    "Customer Price": item["Customer Price"] || item.customerPrice || item.cost || item.Cost || item.customerPriceUSD,
    "Customer Price (USD)": item["Customer Price (USD)"] || item.customerPriceUSD || item["Customer Price"],
    Cost: item.Cost || item.cost || item["Customer Price"],
    // Calculate total from warehouse columns if available
    "NV whse": item["NV whse"] || item.nvWhse || 0,
    "KY whse": item["KY whse"] || item.kyWhse || 0,
    "MFG Invt": item["MFG Invt"] || item.mfgInvt || 0,
    "WA whse": item["WA whse"] || item.waWhse || 0,
    // Total inventory (sum of all warehouses or use provided total)
    "USA Item Availability": (function() {
      const nv = Number(item["NV whse"] || item.nvWhse || 0) || 0;
      const ky = Number(item["KY whse"] || item.kyWhse || 0) || 0;
      const mfg = Number(item["MFG Invt"] || item.mfgInvt || 0) || 0;
      const wa = Number(item["WA whse"] || item.waWhse || 0) || 0;
      const calculated = nv + ky + mfg + wa;
      return calculated > 0 ? calculated : (item["USA Item Availability"] || item.inventory || item.availability || item.quantity || item.qty || 0);
    })(),
    inventory: (function() {
      const nv = Number(item["NV whse"] || item.nvWhse || 0) || 0;
      const ky = Number(item["KY whse"] || item.kyWhse || 0) || 0;
      const mfg = Number(item["MFG Invt"] || item.mfgInvt || 0) || 0;
      const wa = Number(item["WA whse"] || item.waWhse || 0) || 0;
      const calculated = nv + ky + mfg + wa;
      return calculated > 0 ? calculated : (item.inventory || item.availability || item.quantity || item.qty || item["USA Item Availability"] || 0);
    })(),
    "Mfg Part Number": item["Mfg Part Number"] || item.mfgPartNumber || item.manufacturerPartNumber || item["Manufacturer Part Number"],
    "Manufacturer Part Number": item["Manufacturer Part Number"] || item.manufacturerPartNumber || item["Mfg Part Number"],
  };
}

/**
 * Clears the API cache
 */
export function clearAPICache() {
  apiCache = null;
  cacheTimestamp = null;
  console.log("🗑️ API cache cleared");
}

/**
 * Gets the API configuration
 */
export function getAPIConfig() {
  return {
    baseUrl: APG_API_BASE_URL,
    apiKey: APG_API_KEY ? `${APG_API_KEY.substring(0, 8)}...` : "not set",
    cacheAge: cacheTimestamp ? Math.floor((Date.now() - cacheTimestamp) / 1000) : null,
  };
}
