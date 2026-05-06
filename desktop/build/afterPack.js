/**
 * electron-builder afterPack hook — ad-hoc signs the macOS .app.
 *
 * Apple Silicon (arm64) refuses to launch unsigned native binaries, even
 * when quarantine is removed via `xattr -cr`. Apple requires AT LEAST an
 * ad-hoc signature (a self-signed marker, no certificate / cost). Intel
 * is more lenient and runs fine without this.
 *
 * `codesign --sign -` is the magic — the literal dash tells codesign to
 * apply an ad-hoc signature. After this, `xattr -cr` is enough to make
 * the app launch on any Mac.
 */
const { execSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function (context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  try {
    execSync(
      `codesign --force --deep --sign - "${appPath}"`,
      { stdio: 'inherit' }
    );
    // Verify the signature applied. Failure here usually means a nested
    // helper binary was missed; --deep should cover them but doesn't hurt
    // to confirm.
    execSync(
      `codesign --verify --deep --strict "${appPath}"`,
      { stdio: 'inherit' }
    );
    console.log('[afterPack] ad-hoc signing complete');
  } catch (e) {
    console.error('[afterPack] codesign failed:', e.message);
    throw e;
  }
};
