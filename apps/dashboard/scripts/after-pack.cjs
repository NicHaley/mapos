// electron-builder afterPack hook: strip native-module payloads that don't
// match the target platform/arch. Several native deps ship prebuilt binaries
// for *every* platform they support; bundling all of them into a single-target
// build wastes hundreds of MB on binaries that can never run.
//
// Biggest offender: @valhallajs/valhallajs ships darwin/arm64 + linux/x64 +
// linux/arm64 (~60MB each). At runtime it resolves <dir>/<os.platform()>/
// <os.arch()> (see lib/binary-path.js), so only the matching pair is reachable.

const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('electron-builder');

/** Resolve the app's Resources dir (where app.asar.unpacked lives). */
function resourcesDir(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName === 'darwin') {
    return path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

function dirSize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const cur = stack.pop();
    let stat;
    try {
      stat = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(cur)) stack.push(path.join(cur, entry));
    } else {
      total += stat.size;
    }
  }
  return total;
}

function rm(target, removed) {
  if (!fs.existsSync(target)) return;
  const bytes = dirSize(target);
  fs.rmSync(target, { recursive: true, force: true });
  removed.total += bytes;
  removed.items.push(`${(bytes / 1e6).toFixed(1)}MB  ${path.relative(removed.root, target)}`);
}

/** @param {import('electron-builder').AfterPackContext} context */
module.exports = async function afterPack(context) {
  const { electronPlatformName } = context;
  const targetArch = Arch[context.arch]; // 'x64' | 'arm64' | 'armv7l' | 'ia32' | 'universal'
  const unpacked = path.join(resourcesDir(context), 'app.asar.unpacked', 'node_modules');

  if (!fs.existsSync(unpacked)) return;

  const removed = { total: 0, items: [], root: unpacked };

  // --- @valhallajs/valhallajs: keep only <platform>/<arch> ---
  const valhalla = path.join(unpacked, '@valhallajs', 'valhallajs');
  if (fs.existsSync(valhalla)) {
    for (const plat of ['darwin', 'linux', 'win32']) {
      const platDir = path.join(valhalla, plat);
      if (!fs.existsSync(platDir)) continue;
      if (plat !== electronPlatformName) {
        rm(platDir, removed);
        continue;
      }
      // Matching platform: drop non-matching arch subdirs.
      for (const arch of fs.readdirSync(platDir)) {
        if (arch !== targetArch) rm(path.join(platDir, arch), removed);
      }
    }
  }

  if (removed.items.length) {
    console.log(
      `\n  • afterPack: pruned ${(removed.total / 1e6).toFixed(0)}MB of foreign-platform binaries ` +
        `(${electronPlatformName}/${targetArch}):`
    );
    for (const item of removed.items) console.log(`      ${item}`);
    console.log('');
  }
};
