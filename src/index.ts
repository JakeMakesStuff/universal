import { spawn } from '@malept/cross-spawn-promise';
import * as asar from 'asar';
import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as plist from 'plist';

const MACHO_PREFIX = 'Mach-O ';

type MakeUniversalOpts = {
  /**
   * Absolute file system path to the x64 version of your application.  E.g. /Foo/bar/MyApp_x64.app
   */
  x64AppPath: string;
  /**
   * Absolute file system path to the arm64 version of your application.  E.g. /Foo/bar/MyApp_arm64.app
   */
  arm64AppPath: string;
  /**
   * Absolute file system path you want the universal app to be written to.  E.g. /Foo/var/MyApp_universal.app
   *
   * If this file exists it will be overwritten ONLY if "force" is set to true
   */
  outAppPath: string;
  /**
   * Forcefully overwrite any existing files that are in the way of generating the universal application
   */
  force: boolean;
};

enum AsarMode {
  NO_ASAR,
  HAS_ASAR,
}

export const detectAsarMode = async (appPath: string) => {
  const asarPath = path.resolve(appPath, 'Contents', 'Resources', 'app.asar');

  if (!(await fs.pathExists(asarPath))) return AsarMode.NO_ASAR;

  return AsarMode.HAS_ASAR;
};

enum AppFileType {
  MACHO,
  PLAIN,
  INFO_PLIST,
  SNAPSHOT,
  APP_CODE,
}

type AppFile = {
  relativePath: string;
  type: AppFileType;
};

const getAllFiles = async (appPath: string): Promise<AppFile[]> => {
  const files: AppFile[] = [];

  const visited = new Set<string>();
  const traverse = async (p: string) => {
    p = await fs.realpath(p);
    if (visited.has(p)) return;
    visited.add(p);

    const info = await fs.stat(p);
    if (info.isSymbolicLink()) return;
    if (info.isFile()) {
      let fileType = AppFileType.PLAIN;

      const fileOutput = await spawn('file', ['--brief', '--no-pad', p]);
      if (p.includes('app.asar')) {
        fileType = AppFileType.APP_CODE;
      } else if (fileOutput.startsWith(MACHO_PREFIX)) {
        fileType = AppFileType.MACHO;
      } else if (p.endsWith('.bin')) {
        fileType = AppFileType.SNAPSHOT;
      } else if (path.basename(p) === 'Info.plist') {
        fileType = AppFileType.INFO_PLIST;
      }

      files.push({
        relativePath: path.relative(await fs.realpath(appPath), await fs.realpath(p)),
        type: fileType,
      });
    }

    if (info.isDirectory()) {
      for (const child of await fs.readdir(p)) {
        await traverse(path.resolve(p, child));
      }
    }
  };
  await traverse(appPath);

  return files;
};

const dupedFiles = (files: AppFile[]) =>
  files.filter((f) => f.type !== AppFileType.SNAPSHOT && f.type !== AppFileType.APP_CODE);

const sha = async (filePath: string) => {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
};

export const makeUniversalApp = async (opts: MakeUniversalOpts): Promise<void> => {
  if (process.platform !== 'darwin')
    throw new Error('@electron/universal is only supported on darwin platforms');
  if (!opts.x64AppPath || !path.isAbsolute(opts.x64AppPath))
    throw new Error('Expected opts.x64AppPath to be an absolute path but it was not');
  if (!opts.arm64AppPath || !path.isAbsolute(opts.arm64AppPath))
    throw new Error('Expected opts.arm64AppPath to be an absolute path but it was not');
  if (!opts.outAppPath || !path.isAbsolute(opts.outAppPath))
    throw new Error('Expected opts.outAppPath to be an absolute path but it was not');

  if (await fs.pathExists(opts.outAppPath)) {
    if (!opts.force) {
      throw new Error(
        `The out path "${opts.outAppPath}" already exists and force is not set to true`,
      );
    } else {
      await fs.remove(opts.outAppPath);
    }
  }

  const x64AsarMode = await detectAsarMode(opts.x64AppPath);
  const arm64AsarMode = await detectAsarMode(opts.arm64AppPath);

  if (x64AsarMode !== arm64AsarMode)
    throw new Error(
      'Both the x64 and arm64 versions of your application need to have been built with the same asar settings (enabled vs disabled)',
    );

  const tmpDir = await fs.mkdtemp(path.resolve(os.tmpdir(), 'electron-universal-'));

  try {
    const tmpApp = path.resolve(tmpDir, 'Tmp.app');
    await spawn('cp', ['-R', opts.x64AppPath, tmpApp]);

    const uniqueToX64: string[] = [];
    const uniqueToArm64: string[] = [];
    const x64Files = await getAllFiles(await fs.realpath(tmpApp));
    const arm64Files = await getAllFiles(opts.arm64AppPath);

    for (const file of dupedFiles(x64Files)) {
      if (!arm64Files.some((f) => f.relativePath === file.relativePath))
        uniqueToX64.push(file.relativePath);
    }
    for (const file of dupedFiles(arm64Files)) {
      if (!x64Files.some((f) => f.relativePath === file.relativePath))
        uniqueToArm64.push(file.relativePath);
    }
    if (uniqueToX64.length !== 0 || uniqueToArm64.length !== 0) {
      console.error({
        uniqueToX64,
        uniqueToArm64,
      });
      throw new Error(
        'While trying to merge mach-o files across your apps we found a mismatch, the number of mach-o files is not the same between the arm64 and x64 builds',
      );
    }

    for (const file of x64Files.filter((f) => f.type === AppFileType.PLAIN)) {
      const x64Sha = await sha(path.resolve(opts.x64AppPath, file.relativePath));
      const arm64Sha = await sha(path.resolve(opts.arm64AppPath, file.relativePath));
      if (x64Sha !== arm64Sha) {
        console.error(`${x64Sha} !== ${arm64Sha}`);
        throw new Error(
          `Expected all non-binary files to have identical SHAs when creating a universal build but "${file.relativePath}" did not`,
        );
      }
    }

    for (const machOFile of x64Files.filter((f) => f.type === AppFileType.MACHO)) {
      await spawn('lipo', [
        await fs.realpath(path.resolve(tmpApp, machOFile.relativePath)),
        await fs.realpath(path.resolve(opts.arm64AppPath, machOFile.relativePath)),
        '-create',
        '-output',
        await fs.realpath(path.resolve(tmpApp, machOFile.relativePath)),
      ]);
    }

    if (x64AsarMode === AsarMode.NO_ASAR) {
      await fs.move(
        path.resolve(tmpApp, 'Contents', 'Resources', 'app'),
        path.resolve(tmpApp, 'Contents', 'Resources', 'x64.app'),
      );
      await fs.copy(
        path.resolve(opts.arm64AppPath, 'Contents', 'Resources', 'app'),
        path.resolve(tmpApp, 'Contents', 'Resources', 'arm64.app'),
      );
    } else {
      await fs.move(
        path.resolve(tmpApp, 'Contents', 'Resources', 'app.asar'),
        path.resolve(tmpApp, 'Contents', 'Resources', 'x64.app.asar'),
      );
      const x64Unpacked = path.resolve(tmpApp, 'Contents', 'Resources', 'app.asar.unpacked');
      if (await fs.pathExists(x64Unpacked)) {
        await fs.move(
          x64Unpacked,
          path.resolve(tmpApp, 'Contents', 'Resources', 'x64.app.asar.unpacked'),
        );
      }

      await fs.copy(
        path.resolve(opts.arm64AppPath, 'Contents', 'Resources', 'app.asar'),
        path.resolve(tmpApp, 'Contents', 'Resources', 'arm64.app.asar'),
      );
      const arm64Unpacked = path.resolve(
        opts.arm64AppPath,
        'Contents',
        'Resources',
        'app.asar.unpacked',
      );
      if (await fs.pathExists(arm64Unpacked)) {
        await fs.copy(
          arm64Unpacked,
          path.resolve(tmpApp, 'Contents', 'Resources', 'arm64.app.asar.unpacked'),
        );
      }
    }

    const entryAsar = path.resolve(tmpDir, 'entry-asar');
    await fs.mkdir(entryAsar);
    await fs.copy(
      path.resolve(__dirname, '..', '..', 'entry-asar', 'index.js'),
      path.resolve(entryAsar, 'index.js'),
    );
    let pj: any;
    if (x64AsarMode === AsarMode.NO_ASAR) {
      pj = await fs.readJson(
        path.resolve(opts.x64AppPath, 'Contents', 'Resources', 'app', 'package.json'),
      );
    } else {
      pj = JSON.parse(
        (
          await asar.extractFile(
            path.resolve(opts.x64AppPath, 'Contents', 'Resources', 'app.asar'),
            'package.json',
          )
        ).toString('utf8'),
      );
    }
    pj.main = 'index.js';
    await fs.writeJson(path.resolve(entryAsar, 'package.json'), pj);
    const asarOutPath = path.resolve(tmpApp, 'Contents', 'Resources', 'app.asar');
    await asar.createPackage(entryAsar, asarOutPath);

    for (const snapshotsFile of arm64Files.filter((f) => f.type === AppFileType.SNAPSHOT)) {
      await fs.copy(
        path.resolve(opts.arm64AppPath, snapshotsFile.relativePath),
        path.resolve(tmpApp, snapshotsFile.relativePath),
      );
    }

    const plistFiles = x64Files.filter((f) => f.type === AppFileType.INFO_PLIST);
    for (const plistFile of plistFiles) {
      const x64PlistPath = path.resolve(opts.x64AppPath, plistFile.relativePath);
      const arm64PlistPath = path.resolve(opts.arm64AppPath, plistFile.relativePath);

      const { ElectronAsarIntegrity: x64Integrity, ...x64Plist } = plist.parse(
        await fs.readFile(x64PlistPath, 'utf8'),
      ) as any;
      const { ElectronAsarIntegrity: arm64Integrity, ...arm64Plist } = plist.parse(
        await fs.readFile(arm64PlistPath, 'utf8'),
      ) as any;
      if (JSON.stringify(x64Plist) !== JSON.stringify(arm64Plist)) {
        throw new Error(
          `Expected all Info.plist files to be identical when ignoring integrity when creating a universal build but "${plistFile.relativePath}" was not`,
        );
      }

      const mergedPlist = { ...x64Plist };

      if (x64Integrity && arm64Integrity) {
        mergedPlist.ElectronAsarIntegrity = {
          ['Resources/x64.app.asar']: x64Integrity['Resources/app.asar'],
          ['Resources/arm64.app.asar']: arm64Integrity['Resources/app.asar'],
        };
      } else if (x64Integrity || arm64Integrity) {
        throw new Error(
          'Expected both Info.plist files to contain integrity sections but only one did',
        );
      }

      mergedPlist.ElectronAsarIntegrity = mergedPlist.ElectronAsarIntegrity || {};
      mergedPlist.ElectronAsarIntegrity['Resources/app.asar'] = {
        algorithm: 'SHA256',
        hash: crypto
          .createHash('SHA256')
          .update(asar.getRawHeader(asarOutPath).headerString)
          .digest('hex'),
      };

      await fs.writeFile(path.resolve(tmpApp, plistFile.relativePath), plist.build(mergedPlist));
    }

    await fs.mkdirp(path.dirname(opts.outAppPath));
    await spawn('mv', [tmpApp, opts.outAppPath]);
  } catch (err) {
    throw err;
  } finally {
    await fs.remove(tmpDir);
  }
};
