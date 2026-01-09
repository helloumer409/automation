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

export async function syncAPGVariant({
  admin,
  productId,
  variant,
  apgRow
}) {
  // Try multiple possible field names for MAP price
  const mapPriceStr = apgRow.MAP || apgRow.map || apgRow.priceMAP || apgRow["MAP Price"];
  const mapPrice = Number(mapPriceStr);
  
  // Try multiple possible field names for Customer Price
  const costPriceStr = apgRow["Customer Price"] || apgRow["Customer Price (USD)"] || apgRow.Cost || apgRow.cost;
  const costPrice = Number(costPriceStr);

  if (!mapPrice || mapPrice <= 0 || isNaN(mapPrice)) {
    console.log("⏭ MAP invalid, skipping", variant.id, "MAP value:", mapPriceStr);
    return;
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
  
  // ALWAYS ensure tracking is enabled (force update regardless of current state)
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
    throw new Error(`Inventory tracking failed: ${errors.map(e => e.message).join(", ")}`);
  }
  
  if (!trackingResult.data?.inventoryItemUpdate?.inventoryItem?.tracked) {
    console.warn(`⚠️ Tracking might not be enabled for ${variant.sku || variant.barcode}`);
  } else {
    console.log(`✓ Tracking enabled for ${variant.sku || variant.barcode}`);
  }

  // Get location ID for inventory level (cached)
  const locationId = await getLocationId(admin);
  
  if (!locationId) {
    console.error(`❌ No location found - cannot set inventory for ${variant.sku || variant.barcode}. Please configure at least one location in Shopify.`);
    // Continue with price update even if inventory can't be set
  } else {
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
    }
  }

  /* 3️⃣ COST - Must set after tracking is enabled */
  if (costPrice && costPrice > 0 && !isNaN(costPrice)) {
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
      console.warn(`⚠️ Cost update warning: ${errors.map(e => e.message).join(", ")}`);
    } else if (costResult.data?.inventoryItemUpdate?.inventoryItem?.cost) {
      console.log(`💰 Cost set to $${costPrice.toFixed(2)} for ${variant.sku || variant.barcode}`);
    }
  } else if (costPrice === 0 || !costPrice) {
    console.log(`⚠️ No valid cost price found for ${variant.sku || variant.barcode}. Cost fields:`, {
      "Customer Price": apgRow["Customer Price"],
      "Customer Price (USD)": apgRow["Customer Price (USD)"],
      "Cost": apgRow.Cost,
      "cost": apgRow.cost
    });
  }

  console.log(`✅ Synced ${variant.sku || variant.barcode} - Price: $${mapPrice.toFixed(2)}, Inventory: ${inventoryQty}${warehouseTotal > 0 ? ` (NV:${nvWhse}+KY:${kyWhse}+MFG:${mfgInvt}+WA:${waWhse})` : ""}${costPrice > 0 ? `, Cost: $${costPrice.toFixed(2)}` : ""}`);
}
