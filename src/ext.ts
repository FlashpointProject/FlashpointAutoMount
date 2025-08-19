import * as flashpoint from 'flashpoint-launcher';
import * as path from 'path';
import axios from 'axios';

export async function activate(context: flashpoint.ExtensionContext) {
  const fpPath: string = flashpoint.config.flashpointPath;
  const dataPacksPath: string = path.join(fpPath, flashpoint.getPreferences().dataPacksFolderPath);

  async function unmountGame(filePath: string) {
    return axios.post("http://localhost:22501/fpProxy/api/unmountzip", {
      filePath
    })
    .catch((err: any) => {
      flashpoint.log.error(`Failed to mount zip: ${filePath} - ${err}`);
    });
  }

  // Mount a game, if applicable.
  async function mountGame(filePath: string) {
    return axios.post("http://localhost:22501/fpProxy/api/mountzip", {
      filePath
    })
    .catch((err: any) => {
      flashpoint.log.error(`Failed to mount zip: ${filePath} - ${err}`);
      return mountArchiveDataGame(filePath);
    });
  }

  async function mountArchiveDataGame(filePath: string) {
    // Check experimental archive data api is present
    const archiveDataNamespace = (flashpoint as any).archiveData;
    if (archiveDataNamespace !== undefined) {
      const getZipDataOffset = archiveDataNamespace.getZipDataOffset;
      if (getZipDataOffset !== undefined) {
        const archivePath = fixSlashes(path.join('Flashpoint Ultimate', path.relative(fpPath, filePath)));
        flashpoint.log.info(`Trying to mount archive data: ${archivePath}`);
        const zipInfo: any = await getZipDataOffset(archivePath);
        if (zipInfo !== null) {
          // Zip exists, try sending the archive data instead
          return axios.post("http://localhost:22501/fpProxy/api/mountzip", {
            archiveData: zipInfo
          })
          .catch((err: any) => {
            flashpoint.log.error(`Failed to mount zip: ${filePath} - ${err}`);
            return mountArchiveDataGame(filePath);
          });
        }
      }
    }
  }

  flashpoint.games.onWillUninstallGameData(async (gameData) => {
    const filename = getGameDataFilename(gameData);
    const filePath: string = path.resolve(path.join(dataPacksPath, filename));
    flashpoint.log.debug(`Unmounting Game Data: \"${filename}\"`);
    return unmountGame(filePath);
  });

  flashpoint.games.onWillLaunchGame(async (gameLaunchInfo) => {
    if (gameLaunchInfo.activeData) {
      if (gameLaunchInfo.activeData.presentOnDisk) {
        // Data present, mount it now
        const filename = getGameDataFilename(gameLaunchInfo.activeData);
        flashpoint.log.debug("GameData present on disk, mounting...");
        const filePath: string = path.resolve(path.join(dataPacksPath, filename));
        flashpoint.log.debug(`Mount parameters: \"${gameLaunchInfo.activeData.parameters}\"`);
        if (gameLaunchInfo.activeData.parameters?.startsWith("-extract")) {
          flashpoint.log.debug("AutoMount skipping, '-extract' registered.");
        } else {
          return mountGame(filePath);
        }
      } else {
        throw "GameData found but not downloaded, cannot mount.";
      }
    } else {
      flashpoint.log.debug("AutoMount skipping, no GameData registered for Game. Assuming Legacy game.");
    }
  });

  flashpoint.games.onWillLaunchAddApp(async (addAppInfo) => {
    if(addAppInfo.parentGame) {
      if (addAppInfo.parentGame.activeDataId) {
        const activeData = await flashpoint.gameData.findOne(addAppInfo.parentGame.activeDataId)
        if (activeData && activeData.presentOnDisk) {
          // Data present, mount it now
          const filename = getGameDataFilename(activeData);
          flashpoint.log.debug("GameData present on disk, mounting...");
          const filePath: string = path.resolve(path.join(dataPacksPath, filename));
          flashpoint.log.debug(`Mount parameters: \"${activeData.parameters}\"`);
          if (activeData.parameters?.startsWith("-extract")) {
            flashpoint.log.debug("AutoMount skipping, '-extract' registered.");
          } else {
            return mountGame(filePath);
          }
        } else {
          throw "GameData found but not downloaded, cannot mount.";
        }
      } else {
        flashpoint.log.debug("AutoMount skipping, no GameData registered for AddApps's Game. Assuming Legacy game.");
      }
    } else {
      flashpoint.log.error("Unable to determine parent game!");
    }
  });
};

export function getGameDataFilename(data: flashpoint.GameData) {
  const cleanDate = (data.dateAdded as unknown as string).includes('T') ? data.dateAdded : `${data.dateAdded} +0000 UTC`;
  return `${data.gameId}-${(new Date(cleanDate)).getTime()}.zip`;
}

function fixSlashes(str: string): string {
  return str.replace(/\\/g, '/');
}
