# Fix Prisma Windows File Lock Error

If you see this error:
```
EPERM: operation not permitted, rename 'query-engine-windows.exe.tmp...' -> 'query-engine-windows.exe'
```

## Quick Fix (Recommended)

1. **Stop the dev server** (press `Ctrl+C` in the terminal)

2. **Run the fix script:**
   ```powershell
   .\fix-prisma.ps1
   ```

3. **Regenerate Prisma:**
   ```powershell
   npx prisma generate
   ```

4. **Restart dev server:**
   ```powershell
   npm run dev
   ```

## Manual Fix Steps

If the script doesn't work, try these steps:

1. **Stop all Node processes:**
   ```powershell
   Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
   ```

2. **Delete the Prisma client folder:**
   ```powershell
   Remove-Item -Path "node_modules\.prisma" -Recurse -Force
   ```

3. **Close any code editors/IDEs** that might have the file open

4. **Check Windows Defender/Antivirus:**
   - Temporarily disable real-time protection
   - Or add the project folder to exclusions

5. **Regenerate Prisma:**
   ```powershell
   npx prisma generate
   ```

6. **If still failing, try:**
   ```powershell
   npm install
   npx prisma generate
   ```

## Prevention

The Prisma schema has been updated to use `engineType = "library"` instead of `"binary"`, which has fewer file locking issues on Windows.

## Alternative: Skip Prisma During Dev

If you continue to have issues, you can work around it by:
- The dev command already uses `--no-prisma` flag
- But React Router might still try to generate it

To fully skip, you can modify `package.json` dev script, but this is not recommended as Prisma is needed for session storage.
