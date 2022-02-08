import QMP from 'qemu-qmp';
import Ascii85 from 'ascii85';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import * as child_process from 'child_process';
import * as flashpoint from 'flashpoint-launcher';
import * as fs from 'fs';

export async function activate(context: flashpoint.ExtensionContext) {
  const fpPath: string = flashpoint.config.flashpointPath;
  const dataPacksPath: string = path.join(fpPath, flashpoint.getPreferences().dataPacksFolderPath);

  let alreadyLaunched: Set<string> = new Set();

  var dockerGZ: boolean = true;
  fs.readFile(path.join(fpPath, "Data", "services.json"), function (err: Error, data: Buffer) {
    if (err) throw err;
    if(data.includes('qemu-system')){
      dockerGZ = false;
    }
  });

  // uuid.parse() was rejecting some uuids - this is a replacement.
  function uuidToBytes(id: string) {
    // Regex pattern removes all dashes.
    let strid: string = id.replace(/-/g,'');
    // "Allocate" an array to hold the output.
    let arr: Uint8Array = new Uint8Array(strid.length/2);
    // Convert each two-character pair to an int from hex.
    for (var i: number = 0; i < strid.length - 1; i += 2) {
      arr[i/2] = parseInt(strid.slice(i, i+2), 16);
    }
    return arr;
  }

  async function sleep(ms: number) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async function mountGame(id: string, filePath: string) {
    if(alreadyLaunched.has(id)) {
      return;
    }
    alreadyLaunched.add(id);
    if (dockerGZ) {
      flashpoint.log.info("FPMount output: urlopen");
      http.request({host: '127.0.0.1', port: '22500', path: `mount.php?file=${encodeURIComponent(path.basename(filePath))}`}, function(response) {
        var str: string = '';
        response.on('data', function (chunk: string) {
          str += chunk;
        });
        response.on('end', function () {
          flashpoint.log.info(`FPMount output: ${str}`);
        });
      }).end();
    } else {
      flashpoint.log.info(`FPMount output: Mounting ${id}`);
      // Generate a random 16-character string.
      let drive: string = crypto.randomBytes(16).map(function(element) { return (element % 26) + 97; }).toString();
      // Convert the uuid to bytes, then encode it with base85.
      let data: Uint8Array = uuidToBytes(id);
      let serial: string = Ascii85.encode(data).toString('ascii');
      let qmp: QMP = new QMP();
      // This library wants the port before the host?
      qmp.connect(4444, '127.0.0.1', function(err: Error) {
        if (err) throw err;
        qmp.execute('blockdev-add', {'node-name': drive, 'driver': 'raw', 'file': { 'driver': 'file', 'filename': filePath}}, function(err: Error) {
          if (err) throw err;
          qmp.execute('device_add', {'driver': 'virtio-blk-pci', 'drive': drive, 'id': drive, 'serial': serial}, function(err: Error) {
            if (err) throw err;
            flashpoint.log.info("FPMount output: urlopen");
            http.request({host: '127.0.0.1', port: '22500', path: `/mount.php?file=${encodeURIComponent(serial)}`}, function(response) {
              var str: string = '';
              response.on('data', function (chunk: string) {
                str += chunk;
              });
              response.on('end', function () {
                flashpoint.log.info(`FPMount output: ${str}`);
              });
            }).end();
            flashpoint.log.info('FPMount succeeded.');
            qmp.end();
          });
        });
      });
    }
  }

  flashpoint.games.onWillLaunchGame(async (gameLaunchInfo) => {
    if (gameLaunchInfo.activeData) {
      if (gameLaunchInfo.activeData.presentOnDisk) {
        // Data present, mount it now
        flashpoint.log.debug("GameData present on disk, mounting...");
        const filePath: string = path.join(dataPacksPath, gameLaunchInfo.activeData.path)
        return mountGame(gameLaunchInfo.game.id, filePath);
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
          flashpoint.log.debug("GameData present on disk, mounting...");
          const filePath: string = path.join(dataPacksPath, activeData.path)
          return mountGame(addAppInfo.parentGame.id, filePath);
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
