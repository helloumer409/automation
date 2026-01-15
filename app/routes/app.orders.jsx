import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getRecentOrders } from "../services/shopify-orders.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Load a larger slice of recent orders for the dedicated Orders page
  try {
    const recentOrders = await getRecentOrders(admin, 50);
    return { recentOrders, error: null };
  } catch (error) {
    console.log("❌ Failed to load recent orders for Orders page:", error.message);
    return { recentOrders: [], error: error.message || "Failed to load orders" };
  }
};

export default function OrdersPage() {
  const { recentOrders, error } = useLoaderData();
  const fulfillFetcher = useFetcher();
  const [searchTerm, setSearchTerm] = useState("");

  const filteredOrders = (recentOrders || []).filter((order) => {
    if (!searchTerm.trim()) return true;
    const term = searchTerm.trim().toLowerCase();
    const name = (order.name || `#${order.orderNumber || ""}`).toLowerCase();
    const email = (order.customer?.email || "").toLowerCase();
    const customer = (order.customer?.displayName || "").toLowerCase();
    return (
      name.includes(term) ||
      email.includes(term) ||
      customer.includes(term)
    );
  });

  return (
    <s-page heading="Orders → APG Fulfillment">
      <s-section heading="📃 Recent Shopify Orders">
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          {error && (
            <s-text variant="bodySm" tone="critical" style={{ marginBottom: "0.75rem" }}>
              Failed to load orders: {error}
            </s-text>
          )}

          {/* Search bar */}
          <div style={{ marginBottom: "0.75rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search by order number or customer email..."
              style={{
                padding: "8px 10px",
                minWidth: "260px",
                borderRadius: "4px",
                border: "1px solid #c4cdd5",
              }}
            />
            {searchTerm && (
              <s-button
                size="slim"
                variant="secondary"
                onClick={() => setSearchTerm("")}
              >
                Clear
              </s-button>
            )}
          </div>

          {filteredOrders && filteredOrders.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "700px" }}>
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
                    const apgSent =
                      order.customAttributes?.some(
                        (attr) => attr.key === "apg_order_number" && attr.value && attr.value !== "Pending",
                      ) || false;

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
                          {apgSent ? (
                            <s-text variant="bodySm" tone="success">
                              Already sent to APG
                            </s-text>
                          ) : (
                            <fulfillFetcher.Form method="post" action="/app/fulfill-order">
                              <input type="hidden" name="orderId" value={order.id} />
                              <s-button
                                size="slim"
                                variant="primary"
                                loading={fulfillFetcher.state === "submitting"}
                                disabled={fulfillFetcher.state === "submitting"}
                              >
                                {fulfillFetcher.state === "submitting" ? "Sending…" : "Send to APG"}
                              </s-button>
                            </fulfillFetcher.Form>
                          )}
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
    </s-page>
  );
}

