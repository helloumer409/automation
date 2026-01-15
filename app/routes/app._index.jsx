import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getLatestSyncStats } from "../services/sync-stats.server";
import { getProductStats } from "../services/product-stats.server";
import { getRecentOrders } from "../services/shopify-orders.server";


export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  
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
  
  // Get comprehensive product stats
  // For large stores (22k+ products), stats can take 60+ seconds
  // Load stats asynchronously - don't block page load
  // Page will show loading state and update when stats are ready
  let productStats = null;
  try {
    // Use a reasonable timeout (20 seconds) - if it takes longer, show loading state
    // Stats will continue loading in background via client-side fetch
    const statsPromise = getProductStats(admin);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Product stats taking longer than expected - will load in background")), 20000)
    );
    productStats = await Promise.race([statsPromise, timeoutPromise]);
    console.log(`✅ Product stats loaded: ${productStats.totalProducts} products, ${productStats.totalVariants} variants`);
  } catch (error) {
    // Stats are loading but taking longer - page will show loading state
    // Client-side code will fetch stats in background
    console.log("ℹ️ Product stats loading (may take up to 60s for large stores):", error.message);
    productStats = null; // Show loading state on frontend
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
  const retryFetcher = useFetcher();
  const fulfillFetcher = useFetcher();
  const shopify = useAppBridge();
  const [autoRefreshStats, setAutoRefreshStats] = useState(false);
  const statsFetcher = useFetcher();
  const [orderIdInput, setOrderIdInput] = useState("");
  
  const isSyncing = ["loading", "submitting"].includes(syncFetcher.state) &&
    syncFetcher.formMethod === "POST";

  // If stats didn't load initially (timeout), fetch them in background
  useEffect(() => {
    if (!productStats && !statsFetcher.data?.productStats && statsFetcher.state === "idle") {
      // Fetch stats in background after page loads (for large stores)
      const timer = setTimeout(() => {
        statsFetcher.load("/app");
      }, 2000); // Wait 2 seconds after page load
      return () => clearTimeout(timer);
    }
  }, [productStats, statsFetcher]);

  // Auto-refresh stats every 30 seconds when enabled
  useEffect(() => {
    if (!autoRefreshStats) return;
    
    const interval = setInterval(() => {
      statsFetcher.load("/app");
    }, 30000); // Refresh every 30 seconds
    
    return () => clearInterval(interval);
  }, [autoRefreshStats, statsFetcher]);

  useEffect(() => {
    if (syncFetcher.data?.success) {
      shopify.toast.show(syncFetcher.data.message || "Sync completed successfully!");
    } else if (syncFetcher.data?.error) {
      shopify.toast.show(`Sync failed: ${syncFetcher.data.error}`, { isError: true });
    }
  }, [syncFetcher.data, shopify]);

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
      <s-text variant="bodySm" tone="subdued">
        Sync in progress... This may take several minutes for large catalogs. Do not close this page.
      </s-text>
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
                      <strong>{order.name || `#${order.orderNumber}`}</strong>
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
                          if (!confirm(`Send order ${order.name || `#${order.orderNumber}`} to APG now?`)) {
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
            {...(isLoading ? { loading: true } : {})}
          >
            Generate a product
          </s-button>
          {fetcher.data?.product && (
            <s-button
              onClick={() => {
                shopify.intents.invoke?.("edit:shopify/Product", {
                  value: fetcher.data?.product?.id,
                });
              }}
              target="_blank"
              variant="tertiary"
            >
              Edit product
            </s-button>
          )}
        </s-stack>
        {fetcher.data?.product && (
          <s-section heading="productCreate mutation">
            <s-stack direction="block" gap="base">
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <pre style={{ margin: 0 }}>
                  <code>{JSON.stringify(fetcher.data.product, null, 2)}</code>
                </pre>
              </s-box>

              <s-heading>productVariantsBulkUpdate mutation</s-heading>
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <pre style={{ margin: 0 }}>
                  <code>{JSON.stringify(fetcher.data.variant, null, 2)}</code>
                </pre>
              </s-box>
            </s-stack>
          </s-section>
        )}
      </s-section>

      <s-section slot="aside" heading="App template specs">
        <s-paragraph>
          <s-text>Framework: </s-text>
          <s-link href="https://reactrouter.com/" target="_blank">
            React Router
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Interface: </s-text>
          <s-link
            href="https://shopify.dev/docs/api/app-home/using-polaris-components"
            target="_blank"
          >
            Polaris web components
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>API: </s-text>
          <s-link
            href="https://shopify.dev/docs/api/admin-graphql"
            target="_blank"
          >
            GraphQL
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Database: </s-text>
          <s-link href="https://www.prisma.io/" target="_blank">
            Prisma
          </s-link>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Next steps">
        <s-unordered-list>
          <s-list-item>
            Build an{" "}
            <s-link
              href="https://shopify.dev/docs/apps/getting-started/build-app-example"
              target="_blank"
            >
              example app
            </s-link>
          </s-list-item>
          <s-list-item>
            Explore Shopify&apos;s API with{" "}
            <s-link
              href="https://shopify.dev/docs/apps/tools/graphiql-admin-api"
              target="_blank"
            >
              GraphiQL
            </s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
