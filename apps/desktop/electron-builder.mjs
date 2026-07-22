import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import {
  copyExternalRuntimeModulesToSource,
  getExternalRuntimeModulesFilesConfig,
} from './external-runtime-deps.config.mjs';
import {
  copyNativeModulesToSource,
  getAsarUnpackPatterns,
  getNativeModulesFilesConfig,
} from './native-deps.config.mjs';
import {
  assertPtySidecarBinary,
  getPtySidecarBinaryName,
  getPtySidecarBinaryPath,
} from './scripts/buildPtySidecar.mjs';
import { smokePtySidecar } from './scripts/smokePtySidecar.mjs';
import { verifyPackagedSignatures } from './scripts/verifyPtySidecarSigning.mjs';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { listPackage } = require('@electron/asar');

const packageJSON = JSON.parse(await fs.readFile(path.join(__dirname, 'package.json'), 'utf8'));

const channel = process.env.UPDATE_CHANNEL;
const arch = os.arch();
const hasAppleCertificate = Boolean(process.env.CSC_LINK);
const ptySidecarBinaryName = getPtySidecarBinaryName();
const ptySidecarReleasePath = getPtySidecarBinaryPath({ release: true });

// 自定义更新服务器 URL (用于 stable 频道)
const updateServerUrl = process.env.UPDATE_SERVER_URL;

console.info(`🚄 Build Version ${packageJSON.version}, Channel: ${channel}`);
console.info(`🏗️ Building for architecture: ${arch}`);

// Channel identity derived solely from UPDATE_CHANNEL env var.
// Supported channels: stable, nightly, canary
const isStable = !channel || channel === 'stable';
const isNightly = channel === 'nightly';
const isCanary = channel === 'canary';

// Strip trailing channel path from URL for re-appending the correct channel
// Handles both base URL (https://cdn.example.com) and legacy URL with channel (https://cdn.example.com/stable)
const stripChannelSuffix = (url) => url.replace(/\/(stable|nightly|canary|beta)\/?$/, '');

// 根据 channel 配置 publish provider
// - 所有渠道 + UPDATE_SERVER_URL: 使用 generic (S3)
// - 无 UPDATE_SERVER_URL: 回退到 GitHub (本地开发)
const getPublishConfig = () => {
  const channelPath = isStable ? 'stable' : isNightly ? 'nightly' : channel || 'stable';

  if (updateServerUrl) {
    const baseUrl = stripChannelSuffix(updateServerUrl);
    const fullUrl = `${baseUrl}/${channelPath}`;
    console.info(`📦 ${channelPath} channel: Using generic provider (${fullUrl})`);
    return [
      {
        provider: 'generic',
        url: fullUrl,
      },
    ];
  }

  // 本地开发无 S3 时回退到 GitHub
  console.info(`📦 ${channelPath} channel: No UPDATE_SERVER_URL, falling back to GitHub provider`);
  return [
    {
      owner: 'lobehub',
      provider: 'github',
      repo: 'lobehub',
    },
  ];
};

// https://www.electron.build/code-signing-mac#how-to-disable-code-signing-during-the-build-process-on-macos
if (!hasAppleCertificate) {
  // Disable auto discovery to keep electron-builder from searching unavailable signing identities
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  console.info('⚠️ Apple certificate link not found, macOS artifacts will be unsigned.');
}

// 根据版本类型确定协议 scheme
const getProtocolScheme = () => {
  if (isCanary) return 'lobehub-canary';
  if (isNightly) return 'lobehub-nightly';
  return 'lobehub';
};

const protocolScheme = getProtocolScheme();

// Determine icon file based on version type
const getIconFileName = () => {
  if (isStable || isCanary) return 'Icon';
  // nightly uses pre-release icon
  return 'Icon-nightly';
};

const ELECTRON_BUILDER_ARCHITECTURES = new Map([
  [0, 'ia32'],
  [1, 'x64'],
  [2, 'armv7l'],
  [3, 'arm64'],
  [4, 'universal'],
]);

const getPackagedArchitecture = (context) =>
  typeof context.arch === 'string'
    ? context.arch
    : ELECTRON_BUILDER_ARCHITECTURES.get(context.arch) || arch;

const getPackagedResourcesPath = (context) => {
  if (['darwin', 'mas'].includes(context.electronPlatformName)) {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
    );
  }

  return path.join(context.appOutDir, 'resources');
};

const listFilesRecursively = async (root) => {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) files.push(...(await listFilesRecursively(entryPath)));
      else files.push(entryPath);
    }

    return files;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const isLegacyPtyArtifact = (artifactPath) => {
  const segments = artifactPath.replaceAll('\\', '/').toLowerCase().split('/').filter(Boolean);
  const basename = segments.at(-1);

  return (
    segments.some((segment) => segment === 'node-pty' || segment.startsWith('node-pty-')) ||
    basename === 'pty.node' ||
    basename === 'spawn-helper'
  );
};

const verifyPackagedPtySidecar = async (context, resourcesPath) => {
  const binPath = path.join(resourcesPath, 'bin');
  const binEntries = await fs.readdir(binPath, { withFileTypes: true });
  const sidecarEntries = binEntries.filter(
    (entry) =>
      entry.isFile() &&
      (entry.name === 'lobe-pty-sidecar' || entry.name === 'lobe-pty-sidecar.exe'),
  );

  if (sidecarEntries.length !== 1 || sidecarEntries[0].name !== ptySidecarBinaryName) {
    throw new Error(
      `Packaged app must contain exactly one ${ptySidecarBinaryName}; found ${sidecarEntries.map((entry) => entry.name).join(', ') || 'none'}`,
    );
  }

  const packagedSidecarPath = path.join(binPath, sidecarEntries[0].name);
  const expectedArchitecture = getPackagedArchitecture(context);
  await assertPtySidecarBinary({
    binaryPath: packagedSidecarPath,
    expectedArchitecture,
    requireExecutable: context.electronPlatformName !== 'win32',
  });
  await smokePtySidecar(packagedSidecarPath, { expectedArchitecture, timeoutMs: 15_000 });
  await fs.access(path.join(resourcesPath, 'THIRD_PARTY_NOTICES.md'));

  const applicationEntries = [];
  const asarPath = path.join(resourcesPath, 'app.asar');
  try {
    applicationEntries.push(...listPackage(asarPath).map((entry) => `app.asar${entry}`));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  applicationEntries.push(
    ...(await listFilesRecursively(path.join(resourcesPath, 'app.asar.unpacked'))),
    ...(await listFilesRecursively(path.join(resourcesPath, 'app'))),
  );

  const resourceFiles = await listFilesRecursively(resourcesPath);
  const resourceSidecars = resourceFiles.filter((entry) => {
    const basename = path.basename(entry.replaceAll('\\', '/'));
    return basename === 'lobe-pty-sidecar' || basename === 'lobe-pty-sidecar.exe';
  });
  if (
    resourceSidecars.length !== 1 ||
    path.resolve(resourceSidecars[0]) !== path.resolve(packagedSidecarPath)
  ) {
    throw new Error(
      `Packaged resources must contain only ${packagedSidecarPath}; found:\n${resourceSidecars.join('\n') || 'none'}`,
    );
  }
  const legacyArtifacts = [...new Set([...applicationEntries, ...resourceFiles])].filter(
    isLegacyPtyArtifact,
  );
  if (legacyArtifacts.length > 0) {
    throw new Error(
      `Packaged app still contains legacy node-pty artifacts:\n${legacyArtifacts.join('\n')}`,
    );
  }

  const bundledSidecars = applicationEntries.filter((entry) => {
    const basename = path.basename(entry.replaceAll('\\', '/'));
    return basename === 'lobe-pty-sidecar' || basename === 'lobe-pty-sidecar.exe';
  });
  if (bundledSidecars.length > 0) {
    throw new Error(
      `PTY sidecar must only be packaged as an extra resource, not inside the application bundle:\n${bundledSidecars.join('\n')}`,
    );
  }

  console.info(
    `✅ Verified packaged PTY sidecar (${expectedArchitecture}) and removed node-pty payload`,
  );
};

/**
 * @type {import('electron-builder').Configuration}
 * @see https://www.electron.build/configuration
 */
const config = {
  /**
   * BeforePack hook to resolve pnpm symlinks for native modules.
   * This ensures native modules are properly included in the asar archive.
   */
  beforePack: async () => {
    await assertPtySidecarBinary({
      binaryPath: ptySidecarReleasePath,
      expectedArchitecture: arch,
      requireExecutable: process.platform !== 'win32',
    });
    await copyNativeModulesToSource();
    await copyExternalRuntimeModulesToSource();

    // agent-browser is no longer bundled in the installer — BinaryManager
    // lazily downloads it on first use into the per-user cache dir. See
    // apps/desktop/src/main/modules/binaries/agentBrowserBinaries.ts.

    // Build and copy CLI bundle for embedding
    console.info('📦 Building CLI for embedding...');
    execSync('npm run build:cli', { stdio: 'inherit', cwd: __dirname });
    const cliSrc = path.resolve(__dirname, '../cli/dist/index.js');
    const cliDest = path.resolve(__dirname, 'resources/bin/lobe-cli.js');
    await fs.mkdir(path.dirname(cliDest), { recursive: true });
    await fs.copyFile(cliSrc, cliDest);

    // Write a minimal package.json next to the CLI bundle so that
    // createRequire('../package.json') resolves correctly in the packaged app.
    // The CLI script lives at Resources/bin/lobe-cli.js, so '../package.json'
    // resolves to Resources/package.json.
    const cliPkg = JSON.parse(
      await fs.readFile(path.resolve(__dirname, '../cli/package.json'), 'utf8'),
    );
    await fs.writeFile(
      path.resolve(__dirname, 'resources/cli-package.json'),
      JSON.stringify({ name: cliPkg.name, type: 'module', version: cliPkg.version }),
    );
    console.info('✅ CLI bundle copied to resources/bin/lobe-cli.js');
  },
  /**
   * AfterPack hook for copying Liquid Glass Assets.car on macOS 26+.
   *
   * @see https://github.com/electron-userland/electron-builder/issues/9254
   * @see https://github.com/MultiboxLabs/flow-browser/pull/159
   */
  afterPack: async (context) => {
    const isMac = ['darwin', 'mas'].includes(context.electronPlatformName);
    const resourcesPath = getPackagedResourcesPath(context);

    if (isMac) {
      const iconFileName = getIconFileName();
      const assetsCarSource = path.join(__dirname, 'build', `${iconFileName}.Assets.car`);
      const assetsCarDest = path.join(resourcesPath, 'Assets.car');

      try {
        await fs.access(assetsCarSource);
        await fs.copyFile(assetsCarSource, assetsCarDest);
        console.info(`✅ Copied Liquid Glass icon: ${iconFileName}.Assets.car`);
      } catch {
        // Non-critical: Assets.car not found or copy failed
        // App will use fallback .icns icon on all macOS versions
        console.info(`⏭️  Skipping Assets.car (not found or copy failed)`);
      }
    }

    await verifyPackagedPtySidecar(context, resourcesPath);
  },
  afterSign: async (context) => {
    await verifyPackagedSignatures(context, getPackagedResourcesPath(context));
  },
  appId: 'com.lobehub.lobehub-desktop',
  appImage: {
    artifactName: '${productName}-${version}.${ext}',
  },

  // Only explicitly selected native binaries should live outside app.asar.
  asar: {
    smartUnpack: false,
  },

  // Native modules must be unpacked from asar to work correctly
  asarUnpack: getAsarUnpackPatterns(),

  detectUpdateChannel: true,

  directories: {
    buildResources: 'build',
    output: 'release',
  },

  dmg: {
    artifactName: '${productName}-${version}-${arch}.${ext}',
    background: 'resources/dmg.png',
    contents: [
      { type: 'file', x: 150, y: 240 },
      { type: 'link', path: '/Applications', x: 450, y: 240 },
    ],
    iconSize: 80,
    window: {
      height: 400,
      width: 600,
    },
  },

  electronDownload: {
    mirror: 'https://npmmirror.com/mirrors/electron/',
  },
  // Electron uses underscores for macOS .lproj directories and hyphens for
  // Windows/Linux locale packs. Keep the English variants on every platform.
  electronLanguages: ['en', 'en_GB', 'en_US', 'en-GB', 'en-US'],

  files: [
    'dist',
    'resources',
    'dist/renderer/**/*',
    '!resources/bin/**/*',
    '!resources/cli-package.json',
    '!resources/locales',
    '!resources/dmg.png',
    // Exclude all node_modules first
    '!node_modules',
    // Then explicitly include native modules using object form (handles pnpm symlinks)
    ...getNativeModulesFilesConfig(),
    // Include non-native runtime modules that are intentionally externalized from Vite.
    ...getExternalRuntimeModulesFilesConfig(),
  ],
  generateUpdatesFilesForAllChannels: true,
  linux: {
    category: 'Utility',
    icon: 'build/icon.png',
    maintainer: 'electronjs.org',
    target: ['AppImage', 'snap', 'deb', 'rpm', 'tar.gz'],
  },
  mac: {
    binaries: ['Contents/Resources/bin/lobe-pty-sidecar'],
    compression: 'maximum',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      CFBundleIconName: 'AppIcon',
      CFBundleURLTypes: [
        {
          CFBundleURLName: 'LobeHub Protocol',
          CFBundleURLSchemes: [protocolScheme],
        },
      ],
      NSAppleEventsUsageDescription:
        'Application needs to control System Settings to help you grant Full Disk Access automatically.',
      NSCameraUsageDescription: "Application requests access to the device's camera.",
      NSDocumentsFolderUsageDescription:
        "Application requests access to the user's Documents folder.",
      NSDownloadsFolderUsageDescription:
        "Application requests access to the user's Downloads folder.",
      NSMicrophoneUsageDescription: "Application requests access to the device's microphone.",
      NSScreenCaptureUsageDescription:
        'Application requests access to record and analyze screen content for AI assistance.',
    },
    gatekeeperAssess: false,
    hardenedRuntime: hasAppleCertificate,
    notarize: hasAppleCertificate,
    ...(hasAppleCertificate ? {} : { identity: null }),
    target: [
      { arch: [arch === 'arm64' ? 'arm64' : 'x64'], target: 'dmg' },
      { arch: [arch === 'arm64' ? 'arm64' : 'x64'], target: 'zip' },
    ],
  },
  npmRebuild: true,
  nsis: {
    allowToChangeInstallationDirectory: true,
    artifactName: '${productName}-${version}-setup.${ext}',
    createDesktopShortcut: 'always',
    installerHeader: './build/nsis-header.bmp',
    installerSidebar: './build/nsis-sidebar.bmp',
    oneClick: false,
    shortcutName: '${productName}',
    uninstallDisplayName: '${productName}',
    uninstallerSidebar: './build/nsis-sidebar.bmp',
  },
  protocols: [
    {
      name: 'LobeHub Protocol',
      schemes: [protocolScheme],
    },
  ],
  publish: getPublishConfig(),

  // Release notes 配置
  // 可以通过环境变量 RELEASE_NOTES 传入，或从文件读取
  // 这会被写入 latest-mac.yml / latest.yml 中，供 generic provider 使用
  releaseInfo: {
    releaseNotes: process.env.RELEASE_NOTES || undefined,
  },

  extraResources: [
    { from: ptySidecarReleasePath, to: `bin/${ptySidecarBinaryName}` },
    { from: 'resources/bin/lobe-cli.js', to: 'bin/lobe-cli.js' },
    { from: 'resources/cli-package.json', to: 'package.json' },
    { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
  ],

  win: {
    executableName: 'LobeHub',
  },
};

export default config;
