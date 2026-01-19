import { authenticate } from "../shopify.server";
import { getProductStats, getBasicProductStats } from "../services/product-stats.server";

// API endpoint for fetching product stats (used by fetcher.load)
export async function loader({ request }) {
  let admin;
  
  try {
    const authResult = await authenticate.admin(request);
    admin = authResult.admin;
  } catch (error) {
    console.error("❌ Authentication failed in product-stats loader:", error);
    // Return error object - React Router will serialize it
    throw new Response(
      JSON.stringify({
        success: false,
        error: "Authentication failed",
        message: error.message,
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
  
  try {
    // Try to load full stats (with APG matching)
    const productStats = await getProductStats(admin);
    // Return plain object - React Router will serialize to JSON automatically
    return {
      success: true,
      productStats,
    };
  } catch (error) {
    console.error("❌ Error loading product stats:", error);
    // Fallback to basic stats
    try {
      const productStats = await getBasicProductStats(admin);
      return {
        success: true,
        productStats,
      };
    } catch (basicError) {
      // Return error object
      return {
        success: false,
        error: error.message || "Failed to load product stats",
      };
    }
  }
}
