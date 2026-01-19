import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getLatestSyncStats } from "../services/sync-stats.server";
import { getProductStats, getBasicProductStats } from "../services/product-stats.server";
import { getRecentOrders } from "../services/shopify-orders.server";


export const loader = async ({ request }) => {
  let admin, session, shop;
  
  try {
    const authResult = await authenticate.admin(request);
    admin = authResult.admin;
    session = authResult.session;
    shop = session.shop;
  } catch (error) {
    console.error("❌ Authentication failed in app._index loader:", error);
    // Re-throw with user-friendly error
    throw new Response(
      JSON.stringify({
        error: "Authentication failed",
        message: "Your session has expired. Please reinstall the app from your Shopify admin.",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
  
  // Get latest sync stats
  const latestStats = await getLatestSyncStats(shop);

  // Get recent orders (keep list small to avoid heavy memory usage)
  let recentOrders = [];
  try {
    recentOrders = await getRecentOrders(admin, 20);
  } catch (error) {
    console.log("ℹ️ Recent orders load failed:", error.message);
    recentOrders = [];
  }
  
  // Get product stats - try to load full stats, but fall back to basic if it takes too long
  let productStats = null;
  try {
    // Try to load full stats (with APG matching) - use Promise.race to timeout after 10 seconds
    const fullStatsPromise = getProductStats(admin);
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 10000)); // 10 second timeout
    
    productStats = await Promise.race([fullStatsPromise, timeoutPromise]);
    
    if (!productStats) {
      // Timeout - load basic stats instead
      console.log("⏱️ Full stats timed out, loading basic stats...");
      productStats = await getBasicProductStats(admin);
      console.log(`✅ Basic product stats loaded: ${productStats.totalProducts} products, ${productStats.totalVariants} variants`);
      
      // Continue loading full stats in background
      fullStatsPromise.then((fullStats) => {
        console.log(`✅ Full product stats loaded in background: ${fullStats.matchedWithAPG} matched with APG`);
      }).catch((err) => {
        console.log("ℹ️ Full stats loading failed (non-critical):", err.message);
      });
    } else {
      console.log(`✅ Full product stats loaded: ${productStats.matchedWithAPG} matched with APG`);
    }
  } catch (error) {
    // If stats fail, try basic stats
    console.error("❌ Error loading product stats:", error.message);
    try {
      productStats = await getBasicProductStats(admin);
      console.log(`✅ Basic product stats loaded as fallback: ${productStats.totalProducts} products`);
    } catch (basicError) {
      console.error("❌ Error loading basic product stats:", basicError.message);
      productStats = null; // Show loading state on frontend
    }
  }
  
  // Check if auto-sync is enabled
  // Auto-sync is enabled by default (runs every 6 hours)
  // Can be disabled with AUTO_SYNC_DISABLED=true
  // Schedule can be customized with AUTO_SYNC_SCHEDULE env var
  const autoSyncDisabled = process.env.AUTO_SYNC_DISABLED === "true";
  const autoSyncEnabled = !autoSyncDisabled;
  const autoSyncSchedule = process.env.AUTO_SYNC_SCHEDULE || "0 */6 * * * (every 6 hours - default)";

  return {
    latestStats,
    productStats,
    autoSyncEnabled,
    autoSyncSchedule,
    recentOrders,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const color = ["Red", "Orange", "Yellow", "Green"][
    Math.floor(Math.random() * 4)
  ];
  const response = await admin.graphql(
    `#graphql
      mutation populateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            handle
            status
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }
          }
        }
      }`,
    {
      variables: {
        product: {
          title: `${color} Snowboard`,
        },
      },
    },
  );
  const responseJson = await response.json();
  const product = responseJson.data.productCreate.product;
  const variantId = product.variants.edges[0].node.id;
  const variantResponse = await admin.graphql(
    `#graphql
    mutation shopifyReactRouterTemplateUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          barcode
          createdAt
        }
      }
    }`,
    {
      variables: {
        productId: product.id,
        variants: [{ id: variantId, price: "100.00" }],
      },
    },
  );
  const variantResponseJson = await variantResponse.json();

  return {
    product: responseJson.data.productCreate.product,
    variant: variantResponseJson.data.productVariantsBulkUpdate.productVariants,
  };
};

export default function Index() {
  const { latestStats, productStats, autoSyncEnabled, autoSyncSchedule, recentOrders } = useLoaderData();
  const syncFetcher = useFetcher();
  const progressFetcher = useFetcher();
  const retryFetcher = useFetcher();
  const fulfillFetcher = useFetcher();
  const shopify = useAppBridge();
  const [autoRefreshStats, setAutoRefreshStats] = useState(false);
  const statsFetcher = useFetcher();
  const [orderIdInput, setOrderIdInput] = useState("");
  const [progressValue, setProgressValue] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  
  const isSyncing = ["loading", "submitting"].includes(syncFetcher.state) &&
    syncFetcher.formMethod === "POST";

  // If stats didn't load initially or show 0 matches, fetch full stats in background
  useEffect(() => {
    const needsFullStats = !productStats || (productStats.matchedWithAPG === 0 && productStats.totalVariants > 0);
    if (needsFullStats && !statsFetcher.data?.productStats && statsFetcher.state === "idle") {
      // Fetch full stats in background after page loads (for large stores)
      const timer = setTimeout(() => {
        statsFetcher.load("/app/product-stats");
      }, 3000); // Wait 3 seconds after page load
      return () => clearTimeout(timer);
    }
  }, [productStats, statsFetcher]);

  // Auto-refresh stats every 30 seconds when enabled
  useEffect(() => {
    if (!autoRefreshStats) return;
    
    const interval = setInterval(() => {
      statsFetcher.load("/app/product-stats");
    }, 30000); // Refresh every 30 seconds
    
    return () => clearInterval(interval);
  }, [autoRefreshStats, statsFetcher]);

  // Poll sync progress while a sync is in progress (manual or auto-sync)
  useEffect(() => {
    let interval = null;
    let errorCount = 0;
    let pollCount = 0;
    let sessionExpiredCount = 0;
    const MAX_SESSION_EXPIRED = 5; // Stop polling after 5 consecutive session expired errors
    
    const poll = () => {
      // Only poll if not already loading to avoid request spam
      if (progressFetcher.state === "idle") {
        progressFetcher.load("/app/sync-progress");
        pollCount++;
      }
    };

    // Check if we should continue polling
    const shouldContinuePolling = () => {
      // Stop if session expired multiple times (sync may still be running in background)
      if (sessionExpiredCount >= MAX_SESSION_EXPIRED) {
        console.log(`⚠️ Stopping progress polling - session expired ${sessionExpiredCount} times. Sync may still be running in background.`);
        return false;
      }
      
      // Stop if we've had too many other errors
      if (errorCount >= 3 && sessionExpiredCount === 0) {
        return false;
      }
      
      // Stop if we've polled for more than 5 minutes without an active sync
      if (pollCount > 60) {
        const hasActiveSync = isSyncing || 
          (progressFetcher.data?.success && 
           (progressFetcher.data?.status === "running" || 
            (progressFetcher.data?.progress > 0 && progressFetcher.data?.progress < 100)));
        if (!hasActiveSync) {
          return false;
        }
      }
      
      return true;
    };

    // Initial poll on page load to check for auto-sync progress
    poll();
    
    // Poll every 5 seconds, but reduce frequency if session expired
    const pollInterval = progressFetcher.data?.requiresReauth ? 15000 : 5000; // Poll less frequently if session expired
    
    interval = setInterval(() => {
      // Check for errors in the last response
      if (progressFetcher.data?.requiresReauth) {
        sessionExpiredCount++;
        errorCount = 0; // Don't count session expired as regular error
      } else if (progressFetcher.data?.error) {
        errorCount++;
        sessionExpiredCount = 0; // Reset session expired count on other errors
      } else {
        errorCount = 0; // Reset on success
        sessionExpiredCount = 0; // Reset session expired count on success
      }
      
      // Check if we have an active sync
      const hasActiveSync = isSyncing || 
        (progressFetcher.data?.success && 
         (progressFetcher.data?.status === "running" || 
          (progressFetcher.data?.progress > 0 && progressFetcher.data?.progress < 100)));
      
      if (!shouldContinuePolling()) {
        if (sessionExpiredCount >= MAX_SESSION_EXPIRED) {
          console.log(`⚠️ Progress polling stopped - session expired. Sync may still be running. Refresh page to check sync status.`);
        } else {
          console.log(`✅ Stopping progress polling after ${pollCount} checks - no active sync detected`);
        }
        clearInterval(interval);
        return;
      }
      
      // Log when we detect an active sync (for debugging)
      if (hasActiveSync && pollCount === 1) {
        console.log("🔄 Active sync detected - continuing to poll for progress updates");
      }
      
      poll();
    }, pollInterval);
    
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [progressFetcher, isSyncing]);
  
  // Reset error count when we get successful responses
  useEffect(() => {
    if (progressFetcher.data?.success) {
      // Reset any error tracking - successful response received
    }
  }, [progressFetcher.data]);

  // Update local progress bar state when progress fetcher returns data
  useEffect(() => {
    if (progressFetcher.data?.success) {
      const data = progressFetcher.data;
      setProgressValue(data.progress || 0);
      setProgressLabel(
        `${data.progress || 0}% · Synced: ${data.synced || 0}, Skipped: ${data.skipped || 0}, Errors: ${data.errors || 0}`,
      );
    }
  }, [progressFetcher.data]);

  useEffect(() => {
    if (syncFetcher.data?.success) {
      shopify.toast.show(syncFetcher.data.message || "Sync completed successfully!");
      // Reload stats after sync completes to show updated numbers
      setTimeout(() => {
        statsFetcher.load("/app/product-stats");
      }, 2000); // Wait 2 seconds for sync stats to be saved
    } else if (syncFetcher.data?.error) {
      shopify.toast.show(`Sync failed: ${syncFetcher.data.error}`, { isError: true });
    }
  }, [syncFetcher.data, shopify, statsFetcher]);
  
  // Also reload stats when sync progress completes (progress reaches 100%)
  useEffect(() => {
    if (progressFetcher.data?.success && progressFetcher.data?.status === "completed" && progressFetcher.data?.progress >= 100) {
      // Sync just completed - reload stats to show updated numbers
      setTimeout(() => {
        statsFetcher.load("/app/product-stats");
      }, 2000);
    }
  }, [progressFetcher.data, statsFetcher]);

  useEffect(() => {
    if (retryFetcher.data?.success) {
      shopify.toast.show(retryFetcher.data.message || "Retry completed successfully!");
      // Refresh page to update stats
      setTimeout(() => window.location.reload(), 2000);
    } else if (retryFetcher.data?.error) {
      shopify.toast.show(`Retry failed: ${retryFetcher.data.error}`, { isError: true });
    }
  }, [retryFetcher.data, shopify]);

  const startSync = () => syncFetcher.submit({}, { method: "post", action: "/app/sync-apg" });

  // Display sync stats from latest sync, retry, or current sync
  const displayStats = syncFetcher.data || retryFetcher.data || latestStats;
  const lastSyncTime = latestStats?.syncCompletedAt 
    ? new Date(latestStats.syncCompletedAt).toLocaleString()
    : "Never";

  return (
<s-page heading="CPG Automation Manager">
  
  {/* Product Statistics Section */}
  <s-section heading="📦 Store Product Statistics">
    {productStats ? (
      <s-stack direction="block" gap="base">
        <s-grid columns="4">
        <s-grid-item>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-text variant="headingMd">Total Products</s-text>
            <s-text variant="headingLg">{productStats.totalProducts.toLocaleString()}</s-text>
            <s-text variant="bodySm" tone="subdued">{(statsFetcher.data?.productStats || productStats).totalVariants.toLocaleString()} variants</s-text>
          </s-box>
        </s-grid-item>
        
        <s-grid-item>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-text variant="headingMd">Active Products</s-text>
            <s-text variant="bodySm" tone="subdued">{(statsFetcher.data?.productStats || productStats).totalVariants.toLocaleString()} variants</s-text>
          </s-box>
        </s-grid-item>
        
        <s-grid-item>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-text variant="headingMd">Active Products</s-text>
            <s-text variant="headingLg" tone="success">{(statsFetcher.data?.productStats || productStats).activeProducts.toLocaleString()}</s-text>
          </s-box>
        </s-grid-item>
        
        <s-grid-item>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-text variant="headingMd">Draft Products</s-text>
            <s-text variant="headingLg" tone="warning">{(statsFetcher.data?.productStats || productStats).draftProducts.toLocaleString()}</s-text>
          </s-box>
        </s-grid-item>
        
        <s-grid-item>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-text variant="headingMd">With Inventory</s-text>
            <s-text variant="headingLg" tone="success">{(statsFetcher.data?.productStats || productStats).productsWithInventory.toLocaleString()}</s-text>
            <s-text variant="bodySm" tone="subdued">{(statsFetcher.data?.productStats || productStats).inventoryStats.totalQuantity.toLocaleString()} total units</s-text>
          </s-box>
        </s-grid-item>
      </s-grid>
      
      <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued" style={{ marginTop: "1rem" }}>
        <s-heading>🔗 APG Matching Status</s-heading>
        <s-grid columns="3">
          <s-grid-item>
            <s-text variant="bodyMd"><strong>Matched with APG:</strong> {(statsFetcher.data?.productStats || productStats).matchedWithAPG.toLocaleString()}</s-text>
          </s-grid-item>
          <s-grid-item>
            <s-text variant="bodyMd" tone="warning"><strong>Unmatched:</strong> {(statsFetcher.data?.productStats || productStats).unmatchedWithAPG.toLocaleString()}</s-text>
          </s-grid-item>
          <s-grid-item>
            <s-text variant="bodyMd" tone="info"><strong>MAP = 0 (Need Jobber):</strong> {(statsFetcher.data?.productStats || productStats).mapZeroProducts.toLocaleString()}</s-text>
          </s-grid-item>
        </s-grid>
      </s-box>
      </s-stack>
    ) : (
      <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
        <s-text variant="bodyMd">⏳ Loading product statistics...</s-text>
        <s-text variant="bodySm" tone="subdued" style={{ marginTop: "0.5rem" }}>
          This may take up to 30 seconds for stores with 22,000+ products. Please wait or refresh the page.
        </s-text>
      </s-box>
    )}
  </s-section>

  {/* Sync Statistics Section */}
  <s-section heading="📊 Last Sync Results">
    {displayStats && (
      <s-stack direction="block" gap="base">
        <s-grid columns="4">
          <s-grid-item>
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-text variant="headingMd">Total Synced</s-text>
              <s-text variant="headingLg">{displayStats.synced || 0}</s-text>
              {displayStats.total && (
                <s-text variant="bodySm" tone="subdued">of {displayStats.total} variants</s-text>
              )}
            </s-box>
          </s-grid-item>
          
          <s-grid-item>
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-text variant="headingMd">Skipped</s-text>
              <s-text variant="headingLg">{displayStats.skipped || 0}</s-text>
              <s-text variant="bodySm" tone="subdued">No APG match</s-text>
            </s-box>
          </s-grid-item>
          
          <s-grid-item>
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-text variant="headingMd">Errors</s-text>
              <s-text variant="headingLg" tone={displayStats.errors > 0 ? "critical" : "success"}>
                {displayStats.errors || 0}
              </s-text>
            </s-box>
          </s-grid-item>
          
          <s-grid-item>
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-text variant="headingMd">Success Rate</s-text>
              <s-text variant="headingLg">{displayStats.successRate || "0%"}</s-text>
            </s-box>
          </s-grid-item>
        </s-grid>

        {displayStats.mapStats && (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-heading>💰 MAP Pricing Breakdown</s-heading>
            <s-grid columns="4">
              <s-grid-item>
                <s-text variant="bodyMd"><strong>MAP Matched:</strong> {displayStats.mapStats.mapMatched || 0}</s-text>
              </s-grid-item>
              <s-grid-item>
                <s-text variant="bodyMd"><strong>Used Jobber:</strong> {displayStats.mapStats.mapUsedJobber || 0}</s-text>
              </s-grid-item>
              <s-grid-item>
                <s-text variant="bodyMd"><strong>Used Retail:</strong> {displayStats.mapStats.mapUsedRetail || 0}</s-text>
              </s-grid-item>
              <s-grid-item>
                <s-text variant="bodyMd" tone={displayStats.mapStats.mapSkipped > 0 ? "warning" : "success"}>
                  <strong>MAP Skipped:</strong> {displayStats.mapStats.mapSkipped || 0}
                </s-text>
              </s-grid-item>
            </s-grid>
          </s-box>
        )}

        <s-text variant="bodySm" tone="subdued">
          Last sync: {lastSyncTime}
        </s-text>
      </s-stack>
    )}
    
    {!displayStats && (
      <s-text tone="subdued">No sync statistics available yet. Run your first sync to see stats.</s-text>
    )}
  </s-section>

  {/* Automation Status */}
  <s-section heading="🤖 Automation Status">
    <s-box padding="base" borderWidth="base" borderRadius="base" background={autoSyncEnabled ? "success-subdued" : "warning-subdued"}>
      <s-stack direction="block" gap="base">
        <s-text variant="bodyMd">
          <strong>Auto-sync:</strong> {autoSyncEnabled ? "✅ Enabled" : "⚠️ Disabled"}
        </s-text>
        <s-text variant="bodySm" tone="subdued">
          Schedule: {autoSyncSchedule}
        </s-text>
        {autoSyncEnabled && (
          <s-text variant="bodySm" tone="subdued">
            💡 Auto-sync runs automatically in the background. You can also trigger manual sync anytime using the button below.
          </s-text>
        )}
        {!autoSyncEnabled && (
          <s-text variant="bodySm" tone="subdued">
            ⚠️ Auto-sync is disabled. Set AUTO_SYNC_DISABLED=false or remove it to enable (default: every 6 hours)
          </s-text>
        )}
        
        {/* Show progress bar if auto-sync is running (status is "running" OR progress > 0) OR session expired but sync may be running */}
        {autoSyncEnabled && (progressFetcher.data?.success && (progressFetcher.data?.status === "running" || (progressFetcher.data?.progress > 0 && progressFetcher.data?.progress < 100)) || progressFetcher.data?.requiresReauth) && (
          <div style={{ marginTop: "0.75rem" }}>
            <s-text variant="bodySm" tone={progressFetcher.data?.requiresReauth ? "warning" : "info"} style={{ marginBottom: "0.5rem" }}>
              {progressFetcher.data?.requiresReauth 
                ? "⚠️ Session expired - Sync may still be running in background. Refresh page to check status."
                : "🔄 Auto-sync in progress..."
              }
            </s-text>
            {!progressFetcher.data?.requiresReauth && (
              <>
                <div
                  style={{
                    height: "8px",
                    borderRadius: "4px",
                    background: "#f4f6f8",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${progressFetcher.data.progress || 0}%`,
                      background: "#bf0711", // red progress bar
                      transition: "width 0.5s ease-out",
                    }}
                  />
                </div>
                <s-text variant="bodySm" tone="subdued" style={{ marginTop: "0.25rem" }}>
                  {progressFetcher.data.progress || 0}% · Synced: {progressFetcher.data.synced || 0}, Skipped: {progressFetcher.data.skipped || 0}, Errors: {progressFetcher.data.errors || 0}
                </s-text>
              </>
            )}
          </div>
        )}
      </s-stack>
    </s-box>
  </s-section>

  {/* Sync Actions */}
  <s-section heading="🔄 Manual Sync">
    <s-stack direction="inline" gap="base">
      <s-button
        variant="primary"
        onClick={startSync}
        loading={isSyncing}
        disabled={isSyncing}
      >
        {isSyncing ? "Syncing..." : "Sync APG Inventory & Pricing"}
      </s-button>
      
      {(latestStats?.skipped > 0 || latestStats?.mapStats?.mapSkipped > 0) && (
        <s-button
          variant="secondary"
          onClick={() => retryFetcher.submit({}, { method: "post", action: "/app/retry-skipped" })}
          loading={retryFetcher.state === "submitting"}
          disabled={retryFetcher.state === "submitting" || isSyncing}
        >
          {retryFetcher.state === "submitting" ? "Retrying..." : `Retry MAP=0 Products (${latestStats?.mapStats?.mapSkipped || latestStats?.skipped || 0})`}
        </s-button>
      )}
      
      {productStats && productStats.mapZeroProducts > 0 && (
        <s-button
          variant="secondary"
          onClick={() => retryFetcher.submit({}, { method: "post", action: "/app/retry-skipped" })}
          loading={retryFetcher.state === "submitting"}
          disabled={retryFetcher.state === "submitting" || isSyncing}
        >
          {retryFetcher.state === "submitting" ? "Applying Jobber Price..." : `Apply Jobber Price to MAP=0 (${productStats.mapZeroProducts})`}
        </s-button>
      )}
    </s-stack>
    {isSyncing && (
      <div style={{ marginTop: "0.75rem" }}>
        <div
          style={{
            height: "8px",
            borderRadius: "4px",
            background: "#f4f6f8",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${progressValue}%`,
              background: "#bf0711", // red progress bar
              transition: "width 0.5s ease-out",
            }}
          />
        </div>
        <s-text variant="bodySm" tone="subdued" style={{ marginTop: "0.25rem" }}>
          Sync in progress... {progressLabel || "This may take several minutes for large catalogs. Do not close this page."}
        </s-text>
      </div>
    )}
    {latestStats && latestStats.skipped > 0 && (
      <s-text variant="bodySm" tone="info">
        💡 <strong>Retry Skipped</strong> button will apply Jobber pricing to products that were skipped due to MAP=0. This is useful after a full sync.
      </s-text>
    )}
  </s-section>

  {/* Orders → Send to APG */}
  <s-section heading="🧾 Orders → Send to APG">
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="base">
        <s-text variant="bodyMd">
          Enter the Shopify Order ID from the URL (for example, for{" "}
          <code>.../orders/6409159213100</code> paste <code>6409159213100</code> here),
          then click <strong>Send Order to APG</strong>.
        </s-text>

        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="text"
            value={orderIdInput}
            onChange={(e) => setOrderIdInput(e.target.value)}
            placeholder="6409159213100 or full GraphQL ID"
            style={{
              padding: "8px 10px",
              minWidth: "260px",
              borderRadius: "4px",
              border: "1px solid #c4cdd5",
            }}
          />
          <s-button
            variant="primary"
            loading={fulfillFetcher.state === "submitting"}
            disabled={fulfillFetcher.state === "submitting" || !orderIdInput.trim()}
            onClick={() => {
              if (!orderIdInput.trim()) return;
              if (!confirm(`Send order ${orderIdInput.trim()} to APG now?`)) return;
              fulfillFetcher.submit(
                { orderId: orderIdInput.trim() },
                { method: "post", action: "/app/fulfill-order" }
              );
            }}
          >
            {fulfillFetcher.state === "submitting" ? "Sending to APG..." : "Send Order to APG"}
          </s-button>
        </div>

        {fulfillFetcher.data && (
          <s-text
            variant="bodySm"
            tone={fulfillFetcher.data.success ? "success" : "critical"}
          >
            {fulfillFetcher.data.message || fulfillFetcher.data.error}
          </s-text>
        )}
      </s-stack>
    </s-box>
  </s-section>

  {/* Recent Shopify Orders */}
  <s-section heading="📃 Recent Shopify Orders">
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      {recentOrders && recentOrders.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "600px" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>Order</th>
                <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>Customer</th>
                <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>Created</th>
                <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>Total</th>
                <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>Status</th>
                <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>APG</th>
              </tr>
            </thead>
            <tbody>
              {recentOrders.map((order) => {
                const total = order.totalPriceSet?.shopMoney;
                const created = order.createdAt
                  ? new Date(order.createdAt).toLocaleString()
                  : "";
                return (
                  <tr key={order.id}>
                    <td style={{ padding: "8px", borderBottom: "1px solid #f4f6f8" }}>
                      <strong>{order.name}</strong>
                    </td>
                    <td style={{ padding: "8px", borderBottom: "1px solid #f4f6f8" }}>
                      {order.customer?.displayName || order.customer?.email || "Guest"}
                    </td>
                    <td style={{ padding: "8px", borderBottom: "1px solid #f4f6f8" }}>{created}</td>
                    <td style={{ padding: "8px", borderBottom: "1px solid #f4f6f8" }}>
                      {total ? `${Number(total.amount).toFixed(2)} ${total.currencyCode}` : "-"}
                    </td>
                    <td style={{ padding: "8px", borderBottom: "1px solid #f4f6f8" }}>
                      <div>
                        <div>{order.displayFinancialStatus || "-"}</div>
                        <div style={{ fontSize: "11px", color: "#637381" }}>
                          {order.displayFulfillmentStatus || ""}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: "8px", borderBottom: "1px solid #f4f6f8" }}>
                      <s-button
                        size="slim"
                        variant="primary"
                        loading={fulfillFetcher.state === "submitting"}
                        disabled={fulfillFetcher.state === "submitting"}
                        onClick={() => {
                          if (!confirm(`Send order ${order.name} to APG now?`)) {
                            return;
                          }
                          fulfillFetcher.submit(
                            { orderId: order.id },
                            { method: "post", action: "/app/fulfill-order" }
                          );
                        }}
                      >
                        {fulfillFetcher.state === "submitting" ? "Sending..." : "Send to APG"}
                      </s-button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {fulfillFetcher.data && (
            <s-text
              variant="bodySm"
              tone={fulfillFetcher.data.success ? "success" : "critical"}
              style={{ marginTop: "0.75rem" }}
            >
              {fulfillFetcher.data.message || fulfillFetcher.data.error}
            </s-text>
          )}
        </div>
      ) : (
        <s-text tone="subdued">
          No recent orders found or unable to load orders. Make sure the app has read_orders access.
        </s-text>
      )}
    </s-box>
  </s-section>

      <s-section heading="Welcome to CPG Automation">
        <s-paragraph>
          Manage, automate, and optimize your APG inventory, pricing, and orders directly from Shopify Admin.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
