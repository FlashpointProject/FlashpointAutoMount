import QMP from 'qemu-qmp';
import Ascii85 from 'ascii85';
// Change the name of resolve() to toAbs so that it doesn't conflict with the (resolve, reject) of Promises.
import { join, basename, resolve as toAbs } from 'path';
import { randomBytes } from 'crypto';
import { request, RequestOptions } from 'http';
import * as flashpoint from 'flashpoint-launcher';
import { readFile } from 'fs';


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

  // Connects qmp to the given port number and host.
  const qmpConnect = (qmp: QMP, port: number, host: string): Promise<QMP> => {
    // Wrap the callback in a promise.
    return new Promise((resolve, reject) => {
      // Connect to the port and host.
      qmp.connect(port, host, (err: Error) => {
        // If we get an error, reject the promise.
        if (err) return reject(err);
        // If we don't get an error, return qmp.
        resolve(qmp);
      });
    });
  }

  // Executes a command on a given qmp connection.
  const qmpExecute = (qmp, funcname: string, argsdict) => {
    // Wrap the callback in a promise.
    return new Promise((resolve, reject) => {
      // Execute funcname with argsdict as its argument.
      qmp.execute(funcname, argsdict, (err: Error) => {
        // If we get an error, reject the promise.
        if (err) return reject(err);
        // If we don't get an error, return qmp.
        resolve(qmp);
      });
    });
  }

  // A promise to send an http request. It doesn't have to be to
  // mount.php, but that's all it's used for, so the name is fine.
  // qmp will be a nonsense argument if we're on docker,
  // so we type it as any.
  const callPHP = (argsdict: RequestOptions): Promise<string> => {
    // Wrap the request's callback in a promise.
    return new Promise((resolve, reject) => {
      // Make a request, as specified by argsdict.
      request(argsdict, (response) => {
        // Inititalize the response string to empty.
        var str: string = '';
        // Whenever we get a chunk of data, add it to the response string.
        response.on('data', (chunk: string) => {
          str += chunk;
        });
        // When the connection ends, resolve the promise.
        response.on('end', () => {
          // Return a dictionary with str -> (response string), and qmp -> qmp.
          // Be aware: if we're on docker, qmp will be nonsense, like one.
          resolve(str);
        });
      }).end();
    });
  }

  // A function to nudge QMP back into responsiveness.
  async function nudgeQMP() {
    // We create an object for the new connection.
    let nudgeConn: QMP = new QMP();
    // Connect to 4445 (a separate connection), and send a simple command.
    await qmpConnect(nudgeConn, 4445, '127.0.0.1')
    .then((nudgeConn: QMP) => qmpExecute(nudgeConn, 'query-block-jobs', {}))
    .then((nudgeConn: QMP) => {
      // End the connection.
      nudgeConn.end();
    });
  }

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
      await callPHP({host: '127.0.0.1', port: '22500', path: `/mount.php?file=${encodeURIComponent(basename(filePath))}`})
      .then((dict) => {
        // We did it! Log whatever mount.php returned.
        flashpoint.log.info(`mount.php returns: ${dict['str']}`);
      }).catch((err) => {throw err;});
    } else {
      // A variable to track whether the main task has completed.
      // At this point, the main task has not completed.
      let completed: boolean = false;
      let QMPDone = false;
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
      .then((qmp: QMP) => {
        qmp.end();
        QMPDone = true;
        return callPHP({host: '127.0.0.1', port: '22500', path: `/mount.php?file=${encodeURIComponent(serial)}`})
      })
      .then((phpRes) => {
        // When we're done with all that, log whatever mount.php returned.
        flashpoint.log.info(`mount.php returns: ${phpRes}`);
        // Set the flag: we've completed the main task.
        completed = true;
      }).catch((err) => {throw err;});

      // We also have a secondary task: the timer task.
      let timerPromise = new Promise((resolve, reject) => {
        // Arguments: the amount of time to wait before recursing, how deep into the recursion we are, how
        // deep we're allowed to go before we should begin to nudge, and the callback to call when we're done.
        (async function timer(waitTime, depth, maxDepth, callback) {
          // Is the main task still incomplete?
          if (!completed) {
            // Yes. Should we send a nudge?
            if (!QMPDone && depth > maxDepth) {
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
        //   waitTime = 50ms      I wanted it to be lower.
        //   depth = 0            We're starting off with zero recursions.
        //   maxDepth = 10        If it takes longer than 0.5 seconds, begin nudging.
        //   callback = resolve   When the main task is over, then we resolve the promise.
        })(50, 0, 10, resolve);
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
        const filePath: string = toAbs(join(dataPacksPath, gameLaunchInfo.activeData.path));
        flashpoint.log.debug(`Mount parameters: \"${gameLaunchInfo.activeData.parameters}\"`);
        if (gameLaunchInfo.activeData.parameters === "-extract") {
          flashpoint.log.debug("AutoMount skipping, '-extract' registered.");
        } else {
          return mountGame(gameLaunchInfo.game.id, filePath);
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
          flashpoint.log.debug("GameData present on disk, mounting...");
          const filePath: string = join(dataPacksPath, activeData.path)
          flashpoint.log.debug(`Mount parameters: \"${activeData.parameters}\"`);
          if (activeData.parameters === "-extract") {
            flashpoint.log.debug("AutoMount skipping, '-extract' registered.");
          } else {
            return mountGame(addAppInfo.parentGame.id, filePath);
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
