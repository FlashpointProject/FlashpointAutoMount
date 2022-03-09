import QMP from 'qemu-qmp';
import Ascii85 from 'ascii85';
import { join, basename } from 'path';
import { randomBytes } from 'crypto';
import * as flashpoint from 'flashpoint-launcher';
import { readFile } from 'fs';
import { uuidToBytes, qmpConnect, qmpExecute, callPHP, nudgeQMP } from './util';
import { parseMountParams, runParams } from './mountparams';

export async function activate(context: flashpoint.ExtensionContext) {
  const fpPath: string = flashpoint.config.flashpointPath;
  const dataPacksPath: string = join(fpPath, flashpoint.getPreferences().dataPacksFolderPath);

  let alreadyLaunched: Set<string> = new Set();

  var dockerGZ: boolean = true;
  readFile(join(fpPath, "Data", "services.json"), function (err: Error, data: Buffer) {
    if (err) throw err;
    if(data.includes('qemu-system')){
      dockerGZ = false;
    }
  });

  // Mount a game, if applicable.
  async function mountGame(id: string, filePath: string) {
    // If this game is already mounted, don't bother.
    if (alreadyLaunched.has(id)) {
      return;
    }
    // Add this game to the list of mounted ones.
    alreadyLaunched.add(id);
    // If we're on docker, follow docker steps.
    if (dockerGZ) {
      // Docker only needs to send a request to mount.php. The second argument (1) is complete nonsense. We just need two arguments.
      await callPHP({host: '127.0.0.1', port: '22500', path: `/mount.php?file=${encodeURIComponent(basename(filePath))}`}, 1)
      .then((dict) => {
        // We did it! Log whatever mount.php returned.
        flashpoint.log.info(`mount.php returns: ${dict['str']}`);
      }).catch((err) => {throw err;});
    } else {
      // A variable to track whether the main task has completed.
      // At this point, the main task has not completed.
      let completed: boolean = false;
      // Send a log message: we're about to begin mounting.
      flashpoint.log.info(`Mounting ${id}`);
      // Generate a random 16-character string.
      let drive: string = randomBytes(16).map(function(element) { return (element % 26) + 97; }).toString();
      // Convert the uuid to bytes, then encode it with ascii85.
      let data: Uint8Array = uuidToBytes(id);
      let serial: string = Ascii85.encode(data).toString('ascii');
      // Create an object for the QMP connection.
      let qmp: QMP = new QMP();

      // The main task will connect, execute two commands, and send a request to mount.php.
      // Note: this is just a promise to complete the main task. We will ensure that it delivers later.
      let mainTask = qmpConnect(qmp, 4444, '127.0.0.1')
      .then((qmp) => qmpExecute(qmp, 'blockdev-add', {'node-name': drive, 'driver': 'raw', 'read-only': true, 'file': { 'driver': 'file', 'filename': filePath}}))
      .then((qmp) => qmpExecute(qmp, 'device_add', {'driver': 'virtio-blk-pci', 'drive': drive, 'id': drive, 'serial': serial}))
      .then((qmp) => callPHP({host: '127.0.0.1', port: '22500', path: `/mount.php?file=${encodeURIComponent(serial)}`}, qmp))
      .then((dict) => {
        // When we're done with all that, log whatever mount.php returned.
        flashpoint.log.info(`mount.php returns: ${dict['str']}`);
        // Close the qmp connection. We gave callPHP a real qmp argument, so we'll be
        // getting back the real qmp from this.
        dict['qmp'].end();
        // Set the flag: we've completed the main task.
        completed = true;
      }).catch((err) => {throw err;});

      // We also have a secondary task: the timer task.
      let timerPromise = new Promise((resolve, reject) => {
        // This is an anonymous asynchronous recursive function. Say that five times fast.
        // Arguments: the amount of time to wait before recursing, how deep into the recursion we are, how
        // deep we're allowed to go before we should begin to nudge, and the callback to call when we're done.
        (async function timer(waitTime, depth, maxDepth, callback) {
          // Is the main task still incomplete?
          if (!completed) {
            // Yes. Should we send a nudge?
            if (depth > maxDepth) {
              // Yes, send one. Wait for that to complete.
              await nudgeQMP();
            }
            // Recurse (kinda) after waiting waitTime. Pass through all the arguments
            // untouched except depth, which is incremented by one.
            setTimeout(timer, waitTime, waitTime, depth + 1, maxDepth, callback);
          } else {
            // Oh look, the main task finished! Call the callback.
            // Note: it required that I supply it with a return value, so here's
            // a nonsense value to return.
            callback(1)
          }
        // We call this lovely function with the arguments:
        //   waitTime = 200ms     It seemed about right.
        //   depth = 0            We're starting off with zero recursions.
        //   maxDepth = 10        If it takes longer than two seconds, begin nudging.
        //   callback = resolve   When the main task is over, then we resolve the promise.
        })(200, 0, 10, resolve);
      });
      // Evaluate the two promises simultaneously.
      // timerPromise waits on mainTask's completion before resolving, so mainTask will always be first.
      await Promise.race([mainTask, timerPromise]);
    }
  }

  flashpoint.games.onWillLaunchGame(async (gameLaunchInfo) => {
    if (gameLaunchInfo.activeData) {
      if (gameLaunchInfo.activeData.presentOnDisk) {
        // Data present, mount it now
        flashpoint.log.debug("GameData present on disk, mounting...");
        const filePath: string = join(dataPacksPath, gameLaunchInfo.activeData.path)
        flashpoint.log.debug(`Mount parameters: \"${gameLaunchInfo.activeData.parameters}\"`);
        let params: string[] = parseMountParams(gameLaunchInfo.activeData.parameters);
        if (!(await runParams(params, true, alreadyLaunched, dockerGZ))) {
          return false;
        }
        await mountGame(gameLaunchInfo.game.id, filePath);
        return runParams(params, false, alreadyLaunched, dockerGZ);
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
          const filePath: string = join(dataPacksPath, activeData.path)
          flashpoint.log.debug(`Mount parameters: \"${activeData.parameters}\"`);
          let params: string[] = parseMountParams(activeData.parameters);
          if (!(await runParams(params, true, alreadyLaunched, dockerGZ))) {
            return false;
          }
          await mountGame(addAppInfo.parentGame.id, filePath);
          return runParams(params, false, alreadyLaunched, dockerGZ);
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
