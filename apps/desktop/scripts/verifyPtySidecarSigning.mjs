import { execFileSync } from 'node:child_process';
import path from 'node:path';

const hasConfiguredValue = (value) =>
  (typeof value === 'string' && value.trim().length > 0) || typeof value === 'function';

export const hasWindowsSigningConfiguration = (context, environment = process.env) => {
  const platformOptions = context.packager?.platformSpecificBuildOptions ?? {};
  const commonOptions = context.packager?.info?.config ?? {};
  const signtoolOptions = platformOptions.signtoolOptions ?? {};

  if (platformOptions.signExecutable === false || platformOptions.signAndEditExecutable === false) {
    return false;
  }

  return Boolean(
    hasConfiguredValue(environment.WIN_CSC_LINK) ||
    hasConfiguredValue(environment.CSC_LINK) ||
    hasConfiguredValue(platformOptions.cscLink) ||
    hasConfiguredValue(commonOptions.cscLink) ||
    commonOptions.forceCodeSigning === true ||
    platformOptions.azureSignOptions ||
    hasConfiguredValue(signtoolOptions.certificateFile) ||
    hasConfiguredValue(signtoolOptions.certificateSha1) ||
    hasConfiguredValue(signtoolOptions.certificateSubjectName) ||
    hasConfiguredValue(signtoolOptions.sign),
  );
};

const runVerification = (execute, executable, args, options, description) => {
  try {
    execute(executable, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
  } catch (error) {
    // Signing credentials are never command arguments and subprocess output is
    // intentionally not copied into this message. The failing artifact class
    // remains explicit without risking credential disclosure in CI logs.
    throw new Error(`${description} failed`, { cause: error });
  }
};

const getProductFilename = (context) =>
  context.packager?.platformSpecificBuildOptions?.executableName ||
  context.packager?.appInfo?.productFilename;

const getVerificationEnvironment = (environment) => {
  const sanitizedEnvironment = { ...environment };
  for (const key of [
    'AZURE_CLIENT_SECRET',
    'CSC_KEY_PASSWORD',
    'CSC_LINK',
    'WIN_CSC_KEY_PASSWORD',
    'WIN_CSC_LINK',
  ]) {
    delete sanitizedEnvironment[key];
  }
  return sanitizedEnvironment;
};

export const verifyPackagedSignatures = async (
  context,
  resourcesPath,
  { environment = process.env, execute = execFileSync, logger = console } = {},
) => {
  const productFilename = getProductFilename(context);
  if (!productFilename) throw new Error('Cannot resolve packaged application filename');

  if (['darwin', 'mas'].includes(context.electronPlatformName)) {
    // This project deliberately disables signing when CSC_LINK is absent, as
    // occurs in local and fork-PR builds. Signed builds must validate both the
    // nested sidecar and the complete application bundle after electron-builder
    // has applied its signatures.
    if (!hasConfiguredValue(environment.CSC_LINK)) {
      logger.info('Unsigned macOS build; post-sign verification skipped.');
      return { verified: false };
    }

    const appPath = path.join(context.appOutDir, `${productFilename}.app`);
    const sidecarPath = path.join(resourcesPath, 'bin', 'lobe-pty-sidecar');
    runVerification(
      execute,
      'codesign',
      ['--verify', '--strict', '--verbose=2', sidecarPath],
      { env: getVerificationEnvironment(environment) },
      'Nested PTY sidecar code-signature verification',
    );
    runVerification(
      execute,
      'codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', appPath],
      { env: getVerificationEnvironment(environment) },
      'macOS application code-signature verification',
    );
    logger.info('Verified macOS application and PTY sidecar signatures.');
    return { verified: true };
  }

  if (context.electronPlatformName === 'win32') {
    // Unsigned Windows PR/local builds intentionally have no signing settings.
    // Once any supported electron-builder signing mechanism is configured,
    // Authenticode validity becomes a required packaging invariant.
    if (!hasWindowsSigningConfiguration(context, environment)) {
      logger.info('Unsigned Windows build; Authenticode verification skipped.');
      return { verified: false };
    }

    const appPath = path.join(context.appOutDir, `${productFilename}.exe`);
    const sidecarPath = path.join(resourcesPath, 'bin', 'lobe-pty-sidecar.exe');
    const powershellScript = `
$ErrorActionPreference = 'Stop'
$files = @(
  $env:LOBE_DESKTOP_SIGNED_APP_PATH,
  $env:LOBE_DESKTOP_SIGNED_SIDECAR_PATH
)
foreach ($file in $files) {
  if ([string]::IsNullOrWhiteSpace($file)) { throw 'Missing packaged executable path' }
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    $name = [IO.Path]::GetFileName($file)
    throw "Authenticode validation failed for $name ($($signature.Status))"
  }
}
`;
    const encodedScript = Buffer.from(powershellScript, 'utf16le').toString('base64');
    const powershellPath = environment.SystemRoot
      ? path.join(environment.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    runVerification(
      execute,
      powershellPath,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
      {
        env: {
          ...getVerificationEnvironment(environment),
          LOBE_DESKTOP_SIGNED_APP_PATH: appPath,
          LOBE_DESKTOP_SIGNED_SIDECAR_PATH: sidecarPath,
        },
      },
      'Windows application and PTY sidecar Authenticode verification',
    );
    logger.info('Verified Windows application and PTY sidecar Authenticode signatures.');
    return { verified: true };
  }

  return { verified: false };
};
