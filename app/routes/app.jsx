import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  try {
    await authenticate.admin(request);
  } catch (error) {
    // If authentication fails, throw a user-friendly error
    console.error("❌ Authentication failed:", error);
    // Re-throw with a clear message
    throw new Response(
      JSON.stringify({
        error: "Authentication failed",
        message: "Your session has expired. Please reinstall or reauthorize the app in your Shopify admin.",
        code: "AUTH_ERROR",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/orders">Orders</s-link>
        <s-link href="/app/additional">Additional</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  const error = useRouteError();
  
  // Handle 401 authentication errors with a user-friendly message
  if (error?.status === 401 || error?.statusCode === 401) {
    return (
      <div style={{ padding: "2rem", textAlign: "center" }}>
        <h1>Authentication Required</h1>
        <p style={{ marginTop: "1rem", color: "#666" }}>
          Your session has expired or the app needs to be reauthorized.
        </p>
        <p style={{ marginTop: "0.5rem", color: "#666" }}>
          Please try:
        </p>
        <ol style={{ textAlign: "left", display: "inline-block", marginTop: "1rem" }}>
          <li>Reinstalling the app from your Shopify App Store</li>
          <li>Or clicking the app link again from your Shopify admin</li>
        </ol>
        <p style={{ marginTop: "1rem", color: "#999", fontSize: "0.9rem" }}>
          If the problem persists, please contact support.
        </p>
      </div>
    );
  }
  
  return boundary.error(error);
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
