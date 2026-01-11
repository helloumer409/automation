// Cache location ID to avoid fetching it for every variant
let cachedLocationId = null;

async function getLocationId(admin) {
  if (cachedLocationId) return cachedLocationId;

  const locationsResponse = await admin.graphql(`#graphql
    query {
      locations(first: 10) {
        nodes {
          id
          name
          active
        }
      }
    }
  `);
  
  const locationsResult = await locationsResponse.json();
  const activeLocation = locationsResult.data?.locations?.nodes?.find(loc => loc.active) || 
                         locationsResult.data?.locations?.nodes?.[0];
  cachedLocationId = activeLocation?.id || null;
  
  if (cachedLocationId) {
    console.log(`📍 Using location: ${activeLocation.name} (${cachedLocationId})`);
  } else {
    console.warn("⚠️ No location found in Shopify");
  }
  
  return cachedLocationId;
}

export function clearLocationCache() {
  cachedLocationId = null;
}

/**
 * Parses price string, removing currency symbols and formatting
 */
function parsePrice(priceStr) {
  if (!priceStr) return null;
  // Remove $, commas, and whitespace, then convert to number
  const cleaned = String(priceStr).replace(/[$,\s]/g, "").trim();
  const parsed = Number(cleaned);
  return isNaN(parsed) || parsed <= 0 ? null : parsed;
}

export async function syncAPGVariant({
  admin,
  productId,
  variant,
  apgRow
}) {
  // Log the raw APG row data for debugging
  console.log(`🔍 Syncing ${variant.sku || variant.barcode}:`, {
    barcode: variant.barcode,
    sku: variant.sku,
    apgUpc: apgRow.Upc || apgRow.upc,
    apgMap: apgRow.MAP || apgRow.map,
    apgCustomerPrice: apgRow["Customer Price"] || apgRow["Customer Price (USD)"] || apgRow.Cost,
    apgPartNumber: apgRow["Premier Part Number"]
  });

  // Try multiple possible field names for MAP price and parse it
  const mapPriceStr = apgRow.MAP || apgRow.map || apgRow.priceMAP || apgRow["MAP Price"] || apgRow["MAP Price (USD)"];
  const mapPrice = parsePrice(mapPriceStr);
  
  // Try multiple possible field names for Customer Price
  const costPriceStr = apgRow["Customer Price"] || apgRow["Customer Price (USD)"] || apgRow.Cost || apgRow.cost || apgRow["cost"];
  const costPrice = parsePrice(costPriceStr);

  if (!mapPrice) {
    console.log(`⏭ MAP invalid for ${variant.sku || variant.barcode}, skipping. MAP value: "${mapPriceStr}"`);
    return;
  }

  console.log(`💰 Processing ${variant.sku || variant.barcode} - MAP: $${mapPrice.toFixed(2)}${costPrice ? `, Cost: $${costPrice.toFixed(2)}` : " (no cost)"}`);

  /* 1️⃣ PRICE */
  const priceResponse = await admin.graphql(`#graphql
    mutation {
      productVariantsBulkUpdate(
        productId: "${productId}",
        variants: [{
          id: "${variant.id}",
          price: "${mapPrice.toFixed(2)}",
          compareAtPrice: null
        }]
      ) {
        userErrors { message field }
        productVariants {
          id
          price
        }
      }
    }
  `);
  
  const priceResult = await priceResponse.json();
  if (priceResult.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
    const errors = priceResult.data.productVariantsBulkUpdate.userErrors;
    throw new Error(`Price update failed: ${errors.map(e => e.message).join(", ")}`);
  }

  /* 2️⃣ INVENTORY TRACKING & QUANTITY */
  // Calculate inventory from warehouse columns if available, otherwise use USA Item Availability
  const nvWhse = Number(apgRow["NV whse"] || 0) || 0;
  const kyWhse = Number(apgRow["KY whse"] || 0) || 0;
  const mfgInvt = Number(apgRow["MFG Invt"] || 0) || 0;
  const waWhse = Number(apgRow["WA whse"] || 0) || 0;
  const warehouseTotal = nvWhse + kyWhse + mfgInvt + waWhse;
  
  // Use warehouse total if available, otherwise fall back to USA Item Availability
  const inventoryQtyStr = warehouseTotal > 0 
    ? warehouseTotal 
    : (apgRow["USA Item Availability"] || apgRow.inventory || apgRow["Inventory"] || "0");
  const inventoryQty = Math.max(0, Math.floor(Number(inventoryQtyStr) || 0));
  
  // Try to enable tracking, but don't fail if we don't have permission
  // This allows price updates to continue even if inventory scope is missing
  try {
    const trackingResponse = await admin.graphql(`#graphql
      mutation {
        inventoryItemUpdate(
          id: "${variant.inventoryItem.id}",
          input: { tracked: true }
        ) {
          userErrors { message field }
          inventoryItem {
            id
            tracked
          }
        }
      }
    `);
    
    const trackingResult = await trackingResponse.json();
    if (trackingResult.data?.inventoryItemUpdate?.userErrors?.length > 0) {
      const errors = trackingResult.data.inventoryItemUpdate.userErrors;
      // If it's a scope error, warn but continue
      const isScopeError = errors.some(e => e.message.includes("access") || e.message.includes("scope") || e.message.includes("permission"));
      if (isScopeError) {
        console.warn(`⚠️ Inventory tracking skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}. Price updated successfully.`);
      } else {
        console.warn(`⚠️ Inventory tracking warning for ${variant.sku || variant.barcode}: ${errors.map(e => e.message).join(", ")}`);
      }
    } else if (trackingResult.data?.inventoryItemUpdate?.inventoryItem?.tracked) {
      console.log(`✓ Tracking enabled for ${variant.sku || variant.barcode}`);
    }
  } catch (trackingError) {
    // If tracking fails due to scope, continue with price update
    console.warn(`⚠️ Could not enable tracking for ${variant.sku || variant.barcode}: ${trackingError.message}. Continuing with price update...`);
  }

  // Get location ID for inventory level (cached)
  const locationId = await getLocationId(admin);
  
  if (!locationId) {
    console.warn(`⚠️ No location found - cannot set inventory for ${variant.sku || variant.barcode}. Price updated successfully.`);
  } else {
    // Wrap inventory operations in try-catch to not fail entire sync if inventory scope is missing
    try {
    // Get current inventory levels
    const inventoryLevelsResponse = await admin.graphql(`#graphql
      query {
        inventoryItem(id: "${variant.inventoryItem.id}") {
          id
          inventoryLevels(first: 10) {
            nodes {
              id
              location {
                id
              }
              available
            }
          }
        }
      }
    `);
    
    const inventoryLevelsResult = await inventoryLevelsResponse.json();
    let inventoryLevelId = inventoryLevelsResult.data?.inventoryItem?.inventoryLevels?.nodes?.find(
      level => level.location.id === locationId
    )?.id;
    
    // Create inventory level if it doesn't exist
    if (!inventoryLevelId) {
      const createLevelResponse = await admin.graphql(`#graphql
        mutation {
          inventorySetOnHandQuantities(
            input: {
              reason: "correction"
              setQuantities: [{
                inventoryItemId: "${variant.inventoryItem.id}"
                locationId: "${locationId}"
                quantity: ${inventoryQty}
              }]
            }
          ) {
            userErrors { message field }
            inventoryAdjustmentGroup {
              createdAt
              reason
              changes {
                name
                delta
              }
            }
          }
        }
      `);
      
      const createLevelResult = await createLevelResponse.json();
      if (createLevelResult.data?.inventorySetOnHandQuantities?.userErrors?.length > 0) {
        const errors = createLevelResult.data.inventorySetOnHandQuantities.userErrors;
        console.warn(`⚠️ Inventory level creation warning: ${errors.map(e => e.message).join(", ")}`);
      } else {
        console.log(`📦 Inventory set to ${inventoryQty} for ${variant.sku || variant.barcode}`);
      }
    } else {
      // Update existing inventory level
      const setInventoryResponse = await admin.graphql(`#graphql
        mutation {
          inventorySetOnHandQuantities(
            input: {
              reason: "correction"
              setQuantities: [{
                inventoryItemId: "${variant.inventoryItem.id}"
                locationId: "${locationId}"
                quantity: ${inventoryQty}
              }]
            }
          ) {
            userErrors { message field }
            inventoryAdjustmentGroup {
              createdAt
              reason
              changes {
                name
                delta
              }
            }
          }
        }
      `);
      
      const setInventoryResult = await setInventoryResponse.json();
      if (setInventoryResult.data?.inventorySetOnHandQuantities?.userErrors?.length > 0) {
        const errors = setInventoryResult.data.inventorySetOnHandQuantities.userErrors;
        console.warn(`⚠️ Inventory quantity update warning: ${errors.map(e => e.message).join(", ")}`);
      } else {
        console.log(`📦 Inventory updated to ${inventoryQty} for ${variant.sku || variant.barcode}`);
      }
    } catch (inventoryError) {
      // If inventory update fails (e.g., scope error), continue with cost update
      const isScopeError = inventoryError.message?.includes("access") || inventoryError.message?.includes("scope") || inventoryError.message?.includes("permission");
      if (isScopeError) {
        console.warn(`⚠️ Inventory update skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}`);
      } else {
        console.warn(`⚠️ Inventory update failed for ${variant.sku || variant.barcode}: ${inventoryError.message}`);
      }
    }
  }

  /* 3️⃣ COST - Must set after tracking is enabled */
  if (costPrice && costPrice > 0) {
    // Wrap cost update in try-catch to not fail if scope is missing
    try {
    // Ensure tracking is enabled before setting cost
    const costResponse = await admin.graphql(`#graphql
      mutation {
        inventoryItemUpdate(
          id: "${variant.inventoryItem.id}",
          input: { 
            tracked: true
            cost: "${costPrice.toFixed(2)}" 
          }
        ) {
          userErrors { message field }
          inventoryItem {
            id
            cost
            tracked
          }
        }
      }
    `);
    
      const costResult = await costResponse.json();
      if (costResult.data?.inventoryItemUpdate?.userErrors?.length > 0) {
        const errors = costResult.data.inventoryItemUpdate.userErrors;
        const isScopeError = errors.some(e => e.message.includes("access") || e.message.includes("scope") || e.message.includes("permission"));
        if (isScopeError) {
          console.warn(`⚠️ Cost update skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}`);
        } else {
          console.warn(`⚠️ Cost update warning: ${errors.map(e => e.message).join(", ")}`);
        }
      } else if (costResult.data?.inventoryItemUpdate?.inventoryItem?.cost) {
        console.log(`💰 Cost set to $${costPrice.toFixed(2)} for ${variant.sku || variant.barcode}`);
      }
    } catch (costError) {
      const isScopeError = costError.message?.includes("access") || costError.message?.includes("scope") || costError.message?.includes("permission");
      if (isScopeError) {
        console.warn(`⚠️ Cost update skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}`);
      } else {
        console.warn(`⚠️ Cost update failed: ${costError.message}`);
      }
    }
  } else {
    console.log(`⚠️ No valid cost price found for ${variant.sku || variant.barcode}. Cost fields checked:`, {
      "Customer Price": apgRow["Customer Price"],
      "Customer Price (USD)": apgRow["Customer Price (USD)"],
      "Cost": apgRow.Cost,
      "cost": apgRow.cost
    });
  }

  console.log(`✅ Synced ${variant.sku || variant.barcode} - Price: $${mapPrice.toFixed(2)}, Inventory: ${inventoryQty}${warehouseTotal > 0 ? ` (NV:${nvWhse}+KY:${kyWhse}+MFG:${mfgInvt}+WA:${waWhse})` : ""}${costPrice > 0 ? `, Cost: $${costPrice.toFixed(2)}` : ""}`);
}
