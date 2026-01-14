import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getLatestSyncStats } from "../services/sync-stats.server";
import { getProductStats } from "../services/product-stats.server";


export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  
  // Get latest sync stats
  const latestStats = await getLatestSyncStats(shop);
  
  // Get comprehensive product stats
  // Wrap in try-catch and timeout to prevent page from breaking
  let productStats = null;
  try {
    // Set a longer timeout for product stats (60 seconds for large stores)
    const statsPromise = getProductStats(admin);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Product stats timeout after 60 seconds")), 60000)
    );
    productStats = await Promise.race([statsPromise, timeoutPromise]);
    console.log(`✅ Product stats loaded: ${productStats.totalProducts} products, ${productStats.totalVariants} variants`);
  } catch (error) {
    // Log error but don't break the page
    console.error("⚠️ Failed to fetch product stats (non-critical):", error.message);
    productStats = null; // Ensure it's null on error
  }
  
  // Check if auto-sync is enabled
  const autoSyncEnabled = process.env.AUTO_SYNC_SCHEDULE ? true : false;
  const autoSyncSchedule = process.env.AUTO_SYNC_SCHEDULE || "Not configured";

  return {
    latestStats,
    productStats,
    autoSyncEnabled,
    autoSyncSchedule,
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
  const { latestStats, productStats, autoSyncEnabled, autoSyncSchedule } = useLoaderData();
  const fetcher = useFetcher();
  const syncFetcher = useFetcher();
  const retryFetcher = useFetcher();
  const shopify = useAppBridge();
  const [autoRefreshStats, setAutoRefreshStats] = useState(false);
  const statsFetcher = useFetcher();
  
  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";
  const isSyncing = ["loading", "submitting"].includes(syncFetcher.state) &&
    syncFetcher.formMethod === "POST";

  // Auto-refresh stats every 30 seconds when enabled
  useEffect(() => {
    if (!autoRefreshStats) return;
    
    const interval = setInterval(() => {
      statsFetcher.load("/app");
    }, 30000); // Refresh every 30 seconds
    
    return () => clearInterval(interval);
  }, [autoRefreshStats, statsFetcher]);

  useEffect(() => {
    if (fetcher.data?.product?.id) {
      shopify.toast.show("Product created");
    }
  }, [fetcher.data?.product?.id, shopify]);

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

  const generateProduct = () => fetcher.submit({}, { method: "POST" });
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
        {!autoSyncEnabled && (
          <s-text variant="bodySm" tone="subdued">
            To enable automatic syncing, set AUTO_SYNC_SCHEDULE environment variable (e.g., "0 */6 * * *" for every 6 hours)
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

<s-button
  variant="secondary"
  onClick={() => {
    if (confirm("Are you sure you want to remove all compareAtPrice from all products? This cannot be undone.")) {
      fetcher.submit({}, { method: "post", action: "/app/remove-compare-price" });
    }
  }}
>
  Remove All Compare At Prices
</s-button>

<s-button
  variant="secondary"
  onClick={() => {
    if (confirm("Are you sure you want to remove all compareAtPrice from all products? This cannot be undone.")) {
      fetcher.submit({}, { method: "post", action: "/app/remove-compare-price" });
    }
  }}
>
  Remove All Compare At Prices
</s-button>

      <s-button slot="primary-action" onClick={generateProduct}>
        Generate a product
      </s-button>

     <s-section heading="Welcome to CPG Automation">
  <s-paragraph>
    Manage, automate, and optimize your products directly from Shopify Admin.
  </s-paragraph>
</s-section>

      <s-section heading="Get started with products">
        <s-paragraph>
          Generate a product with GraphQL and get the JSON output for that
          product. Learn more about the{" "}
          <s-link
            href="https://shopify.dev/docs/api/admin-graphql/latest/mutations/productCreate"
            target="_blank"
          >
            productCreate
          </s-link>{" "}
          mutation in our API references.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-button
            onClick={generateProduct}
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
