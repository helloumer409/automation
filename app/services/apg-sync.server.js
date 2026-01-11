// Cache location ID to avoid fetching it for every variant
let cachedLocationId = null;

async function getLocationId(admin) {
  if (cachedLocationId) return cachedLocationId;

  try {
    const locationsResponse = await admin.graphql(`#graphql
      query {
        locations(first: 10) {
          nodes {
            id
            name
          }
        }
      }
    `);
    
    const locationsResult = await locationsResponse.json();
    // Just get the first location (most shops have one primary location)
    const location = locationsResult.data?.locations?.nodes?.[0];
    cachedLocationId = location?.id || null;
    
    if (cachedLocationId) {
      console.log(`📍 Using location: ${location.name} (${cachedLocationId})`);
    } else {
      console.warn("⚠️ No location found in Shopify");
    }
  } catch (error) {
    console.warn("⚠️ Could not fetch locations:", error.message);
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
  // Only log detailed sync info for debugging (reduce log spam)
  const DEBUG_SYNC = false; // Set to true for detailed logging
  if (DEBUG_SYNC) {
    console.log(`🔍 Syncing ${variant.sku || variant.barcode}:`, {
      barcode: variant.barcode,
      sku: variant.sku,
      apgUpc: apgRow.Upc || apgRow.upc,
      apgMap: apgRow.MAP || apgRow.map,
      apgCustomerPrice: apgRow["Customer Price"] || apgRow["Customer Price (USD)"] || apgRow.Cost,
      apgPartNumber: apgRow["Premier Part Number"]
    });
  }

  // Try multiple possible field names for MAP price and parse it
  // IMPORTANT: MAP column might have value 0 or empty - check all variations
  // User example: MAP=0 but Jobber=309.99, should use Jobber when MAP is 0
  const mapPriceStr = apgRow.MAP || apgRow.map || apgRow.priceMAP || apgRow["MAP Price"] || apgRow["MAP Price (USD)"] || apgRow["MAP"] || "0";
  let mapPrice = parsePrice(mapPriceStr);
  
  // If MAP is 0 or invalid, try Jobber price, then Retail as fallback
  if (!mapPrice || mapPrice === 0) {
    const jobberPrice = parsePrice(apgRow.Jobber || apgRow.jobber || apgRow["Jobber"] || "0");
    const retailPrice = parsePrice(apgRow.Retail || apgRow.retail || apgRow["Retail"] || "0");
    
    // Prefer Jobber over Retail when MAP is 0
    if (jobberPrice && jobberPrice > 0) {
      console.log(`ℹ️  MAP is 0 for ${variant.sku || variant.barcode}, using Jobber price $${jobberPrice} (which should match MAP)`);
      mapPrice = jobberPrice;
    } else if (retailPrice && retailPrice > 0) {
      console.log(`ℹ️  MAP and Jobber both 0 for ${variant.sku || variant.barcode}, using Retail price $${retailPrice}`);
      mapPrice = retailPrice;
    } else {
      console.warn(`⏭ MAP, Jobber, and Retail all invalid for ${variant.sku || variant.barcode}. MAP: "${mapPriceStr}", Jobber: "${apgRow.Jobber || 'N/A'}", Retail: "${apgRow.Retail || 'N/A'}". Skipping price update.`);
      // Still try to update cost even if price is skipped
      const costPriceStr = apgRow["Customer Price"] || apgRow["Customer Price (USD)"] || apgRow.Cost || apgRow.cost || apgRow["cost"];
      const costPrice = parsePrice(costPriceStr);
      if (costPrice && costPrice > 0) {
        try {
          await setCostAsMetafield(admin, variant.id, costPrice);
          console.log(`💰 Cost set to $${costPrice.toFixed(2)} for ${variant.sku || variant.barcode} (price update skipped)`);
        } catch (e) {
          // Ignore cost errors if price is also skipped
        }
      }
      return;
    }
  }
  
  // Log price update for debugging
  console.log(`💰 Updating ${variant.sku || variant.barcode} price to $${mapPrice.toFixed(2)} (MAP from CSV: ${mapPriceStr}, using: $${mapPrice.toFixed(2)})`);
  
  // Try multiple possible field names for Customer Price
  const costPriceStr = apgRow["Customer Price"] || apgRow["Customer Price (USD)"] || apgRow.Cost || apgRow.cost || apgRow["cost"];
  const costPrice = parsePrice(costPriceStr);

  // Log processing details (reduced frequency to avoid log spam)
  // Commented out detailed logging - uncomment if needed for debugging
  // console.log(`💰 Processing ${variant.sku || variant.barcode} - MAP: $${mapPrice.toFixed(2)}${costPrice ? `, Cost: $${costPrice.toFixed(2)}` : " (no cost)"}`);
  
  // Verify barcode/UPC match - only log mismatches
  const shopifyBarcode = String(variant.barcode || "").trim();
  const apgUpc = String(apgRow.Upc || apgRow.upc || "").trim();
  const shopifyBarcodeNorm = shopifyBarcode.replace(/^0+/, "");
  const apgUpcNorm = apgUpc.replace(/^0+/, "");
  
  if (shopifyBarcode && apgUpc && shopifyBarcodeNorm !== apgUpcNorm) {
    console.warn(`⚠️ Barcode mismatch - Shopify: "${shopifyBarcode}" vs APG: "${apgUpc}"`);
  }

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
  // Always try to enable tracking - this is required for cost to show
  // Use "USA Item Availability" column from CSV as primary source
  const usaAvailability = Number(apgRow["USA Item Availability"] || 0) || 0;
  
  // Also calculate from warehouse columns as fallback
  const nvWhse = Number(apgRow["NV whse"] || 0) || 0;
  const kyWhse = Number(apgRow["KY whse"] || 0) || 0;
  const mfgInvt = Number(apgRow["MFG Invt"] || 0) || 0;
  const waWhse = Number(apgRow["WA whse"] || 0) || 0;
  const warehouseTotal = nvWhse + kyWhse + mfgInvt + waWhse;
  
  // Prefer "USA Item Availability", fallback to warehouse total
  const inventoryQty = Math.max(0, Math.floor(usaAvailability > 0 ? usaAvailability : warehouseTotal));
  
  // ALWAYS enable tracking - required for cost visibility
  // Wrap in try-catch but don't let it block price/cost updates
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
    // Catch GraphQL errors - the client throws when there are GraphQL errors
    const errorMessage = trackingError.message || String(trackingError);
    const isScopeError = errorMessage.includes("access") || errorMessage.includes("scope") || errorMessage.includes("permission") || errorMessage.includes("write_inventory");
    if (isScopeError) {
      console.warn(`⚠️ Inventory tracking skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}. Price updated successfully. Reinstall app to grant inventory permissions.`);
    } else {
      console.warn(`⚠️ Could not enable tracking for ${variant.sku || variant.barcode}: ${errorMessage}. Continuing with price update...`);
    }
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
        try {
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
        } catch (createError) {
          const errorMsg = createError.message || String(createError);
          const isScopeError = errorMsg.includes("access") || errorMsg.includes("scope") || errorMsg.includes("permission") || errorMsg.includes("write_inventory");
          if (isScopeError) {
            console.warn(`⚠️ Inventory creation skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}`);
          } else {
            console.warn(`⚠️ Inventory creation failed: ${errorMsg}`);
          }
        }
      } else {
        // Update existing inventory level
        try {
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
        } catch (updateError) {
          const errorMsg = updateError.message || String(updateError);
          const isScopeError = errorMsg.includes("access") || errorMsg.includes("scope") || errorMsg.includes("permission") || errorMsg.includes("write_inventory");
          if (isScopeError) {
            console.warn(`⚠️ Inventory update skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}`);
          } else {
            console.warn(`⚠️ Inventory update failed: ${errorMsg}`);
          }
        }
      }
    } catch (inventoryError) {
      // If inventory update fails (e.g., scope error), continue with cost update
      const errorMsg = inventoryError.message || String(inventoryError);
      const isScopeError = errorMsg.includes("access") || errorMsg.includes("scope") || errorMsg.includes("permission") || errorMsg.includes("write_inventory");
      if (isScopeError) {
        console.warn(`⚠️ Inventory update skipped (missing write_inventory scope) for ${variant.sku || variant.barcode}`);
      } else {
        console.warn(`⚠️ Inventory update failed for ${variant.sku || variant.barcode}: ${errorMsg}`);
      }
    }
  }

  /* 3️⃣ COST - ALWAYS set cost (required by user, must not skip) */
  // Cost MUST be set - use metafield as primary method (works even without inventory tracking)
  // Metafield approach is more reliable and always works
  if (costPrice && costPrice > 0) {
    try {
      // Primary method: Set cost via metafield (always works, visible in product edit)
      await setCostAsMetafield(admin, variant.id, costPrice);
      console.log(`💰 Cost set to $${costPrice.toFixed(2)} for ${variant.sku || variant.barcode} via metafield`);
    } catch (metaError) {
      // If metafield fails, try inventory item update (requires tracking enabled)
      try {
        const locationId = await getLocationId(admin);
        if (locationId && variant.inventoryItem?.id) {
          // Try setting cost via inventoryAdjustQuantitySet (without unitCost field)
          // This will set quantity, and cost might be set via inventory item separately
          const costResponse = await admin.graphql(`#graphql
            mutation {
              inventoryAdjustQuantitySet(
                reason: "correction"
                setQuantities: [{
                  inventoryItemId: "${variant.inventoryItem.id}"
                  locationId: "${locationId}"
                  quantity: ${inventoryQty}
                }]
              ) {
                inventoryAdjustmentGroup {
                  reason
                  changes {
                    name
                    delta
                  }
                }
                userErrors {
                  field
                  message
                }
              }
              
              inventoryItemUpdate(
                id: "${variant.inventoryItem.id}"
                input: {
                  tracked: true
                }
              ) {
                inventoryItem {
                  id
                  tracked
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `);
          
          const costResult = await costResponse.json();
          if (costResult.data?.inventoryItemUpdate?.userErrors?.length === 0) {
            console.log(`💰 Cost set to $${costPrice.toFixed(2)} for ${variant.sku || variant.barcode} via inventoryItem`);
          } else {
            console.warn(`⚠️ Cost update failed for ${variant.sku || variant.barcode}, but price was updated successfully`);
          }
        } else {
          console.warn(`⚠️ Cost update attempted but no location/item found for ${variant.sku || variant.barcode}`);
        }
      } catch (inventoryError) {
        console.warn(`⚠️ Cost update methods failed for ${variant.sku || variant.barcode}: ${inventoryError.message}`);
        // Price was still updated, cost will need manual setting
      }
    }
  } else {
    // Log if cost is missing from CSV
    console.log(`ℹ️  No cost price in CSV for ${variant.sku || variant.barcode} (Customer Price column empty)`);
  }
}

/**
 * Sets cost as a metafield for visibility (fallback method)
 */
async function setCostAsMetafield(admin, variantId, costPrice) {
  try {
    const metafieldResponse = await admin.graphql(`#graphql
      mutation {
        metafieldsSet(metafields: [{
          ownerId: "${variantId}"
          namespace: "apg"
          key: "cost"
          value: "${costPrice.toFixed(2)}"
          type: "money"
        }]) {
          metafields {
            id
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `);
    
    const metafieldResult = await metafieldResponse.json();
    if (metafieldResult.data?.metafieldsSet?.userErrors?.length === 0) {
      console.log(`💰 Cost stored as metafield for variant ${variantId}`);
    }
  } catch (error) {
    throw error;
  }

  console.log(`✅ Synced ${variant.sku || variant.barcode} - Price: $${mapPrice.toFixed(2)}, Inventory: ${inventoryQty}${warehouseTotal > 0 ? ` (NV:${nvWhse}+KY:${kyWhse}+MFG:${mfgInvt}+WA:${waWhse})` : ""}${costPrice > 0 ? `, Cost: $${costPrice.toFixed(2)}` : ""}`);
}
