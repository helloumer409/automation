# Automated Sync Setup Guide

This document explains how to set up automated product synchronization with APG.

## Overview

The app now supports **automatic synchronization** of product pricing, inventory, and costs from APG CSV data. This ensures:
- ✅ MAP pricing is always enforced (prevents brand bans)
- ✅ Inventory levels stay accurate (prevents overselling)
- ✅ Cost prices are always up-to-date
- ✅ No manual intervention required

## Architecture

### 1. Manual Sync (Button Click)
- Available in the app dashboard
- Runs immediately when clicked
- Shows real-time progress and statistics
- Statistics are saved to database

### 2. Automated Sync (Scheduled)
- Runs on a schedule (configurable)
- Uses Railway cron jobs or node-cron
- Requires offline access tokens for Shopify

## Setup Instructions

### Option 1: Railway Cron Jobs (Recommended)

1. **Set up cron secret** in Railway environment variables:
   ```
   SHOPIFY_CRON_SECRET=your-secret-key-here
   ```

2. **Add Railway cron job**:
   - Go to Railway → Your Project → Settings → Cron Jobs
   - Add new cron job:
     - **Schedule**: `0 */6 * * *` (every 6 hours at minute 0)
     - **Command**: `curl -X GET "https://your-app.railway.app/cron/sync-apg?secret=your-secret-key-here"`
   
   **Schedule Examples**:
   - `0 * * * *` - Every hour
   - `0 */2 * * *` - Every 2 hours
   - `0 */6 * * *` - Every 6 hours (recommended)
   - `0 9 * * *` - Daily at 9 AM
   - `*/30 * * * *` - Every 30 minutes (use with caution)

### Option 2: Node-Cron (Internal Scheduling)

1. **Set environment variable** in Railway:
   ```
   AUTO_SYNC_SCHEDULE=0 */6 * * *
   ```

2. **The cron job will start automatically** when the app boots (requires app restart)

**Note**: Node-cron requires the app to stay running. Railway cron is more reliable for production.

## Dashboard Statistics

The app dashboard now shows:

1. **Sync Statistics**:
   - Total synced products
   - Skipped products (no APG match)
   - Errors count
   - Success rate

2. **MAP Pricing Breakdown**:
   - How many products used MAP price
   - How many used Jobber price (when MAP was 0)
   - How many used Retail price (fallback)
   - How many were skipped (all prices invalid)

3. **Automation Status**:
   - Whether auto-sync is enabled
   - Current schedule
   - Last sync timestamp

## Why Use Jobber Price When MAP is 0?

**MAP (Minimum Advertised Price)** is the minimum price a manufacturer allows you to advertise. When MAP = 0 in the CSV, it means:
- The product has no MAP restriction, OR
- MAP data is not available for that product

In these cases, we use **Jobber Price** (wholesale cost + markup) as the selling price, which ensures:
- Products are still priced competitively
- You maintain profit margins
- No products are skipped due to missing MAP

If both MAP and Jobber are 0, we fall back to **Retail Price**.

## Database Schema

Sync statistics are stored in the `SyncStats` table:
- Shop domain
- Sync timestamps
- Product/variant counts
- Success rates
- MAP pricing breakdown
- Error messages (if failed)

## Troubleshooting

### "Automated sync requires offline token setup"
This means the app needs offline access tokens to run syncs without user interaction. Currently, manual sync (button click) works immediately because the user is authenticated.

**To enable full automation**:
1. Ensure your Shopify app uses offline access tokens (default in Shopify apps)
2. The session stored in the database should have a valid `accessToken`
3. Verify the token hasn't expired

### "No active sessions found"
- Make sure you've installed the app in your Shopify store
- Check that the session hasn't expired in the database
- Reinstall the app if needed

### Sync fails with "Missing access token"
- Ensure scopes are correctly set in `shopify.app.toml`
- Reinstall the app in Shopify admin
- Check Railway environment variables: `SCOPES` should include all required scopes

## Next Steps

1. **Run the database migration**:
   ```bash
   npx prisma migrate deploy
   ```

2. **Set up Railway cron** (recommended) or set `AUTO_SYNC_SCHEDULE` env var

3. **Test manual sync** first using the button in the dashboard

4. **Monitor the dashboard** to see sync statistics and automation status

5. **Adjust schedule** based on your needs (more frequent = more API calls)

## Important Notes

- **Railway filesystem is ephemeral** - CSV files are downloaded fresh on each sync
- **Sync duration** depends on catalog size (22,000+ products may take 10-30 minutes)
- **Rate limiting** - Progress logs are reduced to prevent Railway rate limits
- **Cost updates** use metafields (always work, even without inventory permissions)
