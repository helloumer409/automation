import { ApiVersion } from "@shopify/shopify-app-react-router/server";

/**
 * Fetch a page of recent orders from Shopify.
 * Kept small (e.g., 20–30) to avoid heavy memory usage.
 */
export async function getRecentOrders(admin, limit = 20) {
  if (!admin || !admin.graphql) {
    throw new Error("Admin context is missing - cannot fetch orders");
  }

  const first = Math.max(1, Math.min(limit, 50)); // clamp between 1 and 50

  const query = `#graphql
    query RecentOrders($first: Int!) {
      orders(first: $first, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          orderNumber
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customer {
            displayName
            email
          }
          customAttributes {
            key
            value
          }
        }
      }
    }
  `;

  const res = await admin.graphql(query, {
    variables: { first },
    apiVersion: ApiVersion.October25,
  });

  const json = await res.json();

  if (json.errors) {
    throw new Error(json.errors.map(e => e.message).join(", "));
  }

  return json.data?.orders?.nodes || [];
}

