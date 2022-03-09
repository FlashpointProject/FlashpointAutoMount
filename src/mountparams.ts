import * as flashpoint from 'flashpoint-launcher';
import { createHash, randomBytes } from 'crypto';
import Ascii85 from 'ascii85';
import { uuidToBytes, qmpConnect, qmpExecute, callPHP, nudgeQMP } from './util';
import QMP from 'qemu-qmp';
import { basename } from 'path';

// Valid single-word mount paramters.
const singlewords = ["extract"]
// Valid 'type' values for triplet mount parameters.
const triplets = ["extra"]

// An object that holds a task that will be run before or after mounting.
type mountTask = {
  // Boolean return value indicates if we should continue with
  // other functions and mounting.
  runFunc: (args: string[], currentlyMounted: Set<string>, isDocker: boolean) => Promise<boolean>;
  // Should this be run before or after mounting?
  runBefore: boolean;
  // The number of arguments that this task takes.
  numArgs: number;
}

// This holds the functions and relevant information for each keyword.
const keywordFunctions: Record<string, mountTask> = {
  "extract": {
    runFunc: function(args: string[], currentlyMounted: Set<string>, isDocker: boolean) {
      return new Promise((resolve, reject) => {
        resolve(false);
      });
    },
    runBefore: true,
    numArgs: 0
  },
  "extra": {
    runFunc: function(args: string[], currentlyMounted: Set<string>, isDocker: boolean) {
      return new Promise((resolve, reject) => {
        // If it's already mounted, just return true.
        if (currentlyMounted.has(args[0])) {
          resolve(true);
        } else {
          currentlyMounted.add(args[0]);
        }
        if (isDocker) {
          flashpoint.log.info(`Mounting ${args[0]}`);
          callPHP({host: '127.0.0.1', port: '22500', path: `/mount.php?nonzip=${encodeURIComponent(basename(args[0]))}&nzloc=${encodeURIComponent(args[1])}`}, 1)
          .then((dict) => {
            // We did it! Log whatever mount.php returned.
            flashpoint.log.info(`mount.php returns: ${dict['str']}`);
            resolve(true);
          }).catch((err) => {reject(err)});
        } else {
          // A variable to track whether the main task has completed.
          // At this point, the main task has not completed.
          let completed: boolean = false;
          // Send a log message: we're about to begin mounting.
          flashpoint.log.info(`Mounting ${args[0]}`);
          // Generate a random 16-character string.
          let drive: string = randomBytes(16).map(function(element) { return (element % 26) + 97; }).toString();
          // Use the MD5sum of the file's path to generate the serial.
          let data: Uint8Array = createHash("md5").update(args[0]).digest();
          let serial: string = Ascii85.encode(data).toString('ascii');
          let qmp = new QMP();
          let mainTask = qmpConnect(qmp, 4444, '127.0.0.1')
          .then((qmp) => qmpExecute(qmp, 'blockdev-add', {'node-name': drive, 'driver': 'raw', 'read-only': true, 'file': { 'driver': 'file', 'filename': args[0]}}))
          .then((qmp) => qmpExecute(qmp, 'device_add', {'driver': 'virtio-blk-pci', 'drive': drive, 'id': drive, 'serial': serial}))
          .then((qmp) => callPHP({host: '127.0.0.1', port: '22500', path: `/mount.php?nonzip=${encodeURIComponent(serial)}&nzloc=${encodeURIComponent(args[1])}`}, qmp))
          .then((dict) => {
            // When we're done with all that, log whatever mount.php returned.
            flashpoint.log.info(`mount.php returns: ${dict['str']}`);
            // Close the qmp connection. We gave callPHP a real qmp argument, so we'll be
            // getting back the real qmp from this.
            dict['qmp'].end();
            // Set the flag: we've completed the main task.
            completed = true;
            return new Promise((resolve,reject) => {resolve(true);});
          }).catch((err) => {reject(err);});
          // We also have a secondary task: the timer task.
          let timerPromise: PromiseLike<boolean> = new Promise((resolve, reject) => {
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
                callback(true)
              }
            // We call this lovely function with the arguments:
            //   waitTime = 20ms      Shorter than the other one, because this should require no computational power.
            //   depth = 0            We're starting off with zero recursions.
            //   maxDepth = 10        If it takes longer than 0.2 seconds, begin nudging.
            //   callback = resolve   When the main task is over, then we resolve the promise.
            })(20, 0, 10, resolve);
          });
          // Evaluate the two promises simultaneously.
          // timerPromise waits on mainTask's completion before resolving, so mainTask will always be first.
          Promise.race([mainTask, timerPromise]).then((value: boolean) => {resolve(value)}).catch((err) => {reject(err);});
        }
      });
    },
    runBefore: false,
    numArgs: 2
  }
}

// Parse the mount parameters character-by-character.
// Return an array of parameters, keys, values, etc.
export function parseMountParams(params: string): string[] {
  let currentIndex: number = 0;
  let argsarr = [];
  const ignoreChars = ['-', ' ', ';'];
  // -1 = before first word, 0 = in first word, term, etc., 1 = middle element of triplet, 2 = last element of triplet, 3 = end of triplet.
  let argtype = -1;
  let nextEscaped = false;
  while (currentIndex < params.length) {
    // Check: is the current character a backslash, and are we not currently escaping a character?
    if (!nextEscaped && params[currentIndex] == "\\") {
      // Set nextEscaped to true.
      nextEscaped = true;
    // If we're escaping a character
    } else if (nextEscaped) {
      // Check that we have an element to append to.
      if (argsarr.length != 0) {
        // Append the character without parsing logic.
        argsarr[argsarr.length - 1] += params[currentIndex];
      } else {
        // Throw an error: the first character of a command should't be escaped.
        throw "Error: the first character of a mount parameter can't be a escaped!";
      }
      // This wasn't an escaping backslash, so we should reset nextEscaped.
      nextEscaped = false;
    } else {
      switch (argtype) {
        // Case: we're at the first part of a parameter.
        // The previous character was a space.
        case -1:
          // Ignore a leading ignored character.
          if (!ignoreChars.includes(params[currentIndex])) {
            // Create a new element from that character.
            argsarr.push(params[currentIndex]);
            // Change the argtype: we're parsing a real argument.
            argtype = 0;
          } else {
            // If we ignore a character, send a warning about it.
            flashpoint.log.warn(`Ignoring leading mount parameter character: "${params[currentIndex]}".`);
          }
          break;
        // We're in the first part of the parameter.
        case 0:
          // If we hit a space, we've gotten a single-word delmiter. Parse this as a word.
          if (params[currentIndex] == ' ') {
            // Check: is this a valid single-word term?
            if (singlewords.includes(argsarr[argsarr.length - 1])) {
              // If we're on a valid single word, continue back to a state of -1.
              argtype = -1;
            } else {
              // Throw an error. The user gave us an unrecognized single-word command.
              throw `Error: unrecognized single-word mount parameter "${argsarr[argsarr.length - 1]}".`;
            }
          // If we hit a semicolon, we've gotten a triplet delimiter. Parse this as a triplet's 'type' element.
          } else if (params[currentIndex] == ';') {
            // Check: is this a valid triplet type?
            if (triplets.includes(argsarr[argsarr.length - 1])) {
              // If we're on a valid triplet type, proceed to a state of 1.
              argtype = 1;
              // Init the next element to empty.
              argsarr.push("");
            } else {
              // Throw an error. The user gave us an unrecognized triplet type.
              throw `Error: unrecognized triplet type "${argsarr[argsarr.length - 1]}".`;
            }
          } else {
            // Append to the character. Leave the state as-is.
            argsarr[argsarr.length - 1] += params[currentIndex];
          }
          break;
        // We're on a triplet's 'key' element.
        case 1:
          // If we hit a semicolon, move on to the next element.
          if (params[currentIndex] == ';') {
            // Move to the next element.
            argtype = 2;
            // Init it to empty.
            argsarr.push("");
          } else {
            // It's a non-semicolon character, so we append it.
            argsarr[argsarr.length - 1] += params[currentIndex];
          }
          break;
        // We're on a triplet's 'value' element.
        case 2:
          // If we hit a semicolon, end the triplet.
          if (params[currentIndex] == ';') {
            // Signal that we're at the end of the triplet.
            argtype = 3;
          } else {
            // It's a non-semicolon character, so we append it.
            argsarr[argsarr.length - 1] += params[currentIndex];
          }
          break;
        // We just finished a triplet. The current character must be a space.
        case 3:
          if (params[currentIndex] != ' ') {
            throw "Error: expected space after triplet mount parameter!";
          }
          // Move back to -1.
          argtype = -1;
          break;
        default:
          // Um... no clue how we got here. Throw an error, we shouldn't be here.
          throw `Error: undefined state value ${argtype}`;
          break;
      }
    // We didn't hit a backslash, so the next character isn't escaped.
    nextEscaped = false;
    }
    // Move to the next character.
    currentIndex++;
  }
  // Okay, we're done iterating over the characters. Let's check that we're in a valid end state.
  switch (argtype) {
    case 0:
      // We're at the end, and still parsing a first word. This must be a single-word parameter.
      // Check: is this an invalid single-word term?
      if (!singlewords.includes(argsarr[argsarr.length - 1])) {
        // Throw an error. The user gave us an unrecognized single-word command.
        throw `Error: unrecognized single-word mount parameter "${argsarr[argsarr.length - 1]}".`;
      }
      break;
    case 1:
      // We're at the end, and we were parsing the 'key' element of a triplet.
      throw "Error: parameters ended in the middle of a triplet! Final triplet element missing?";
      break;
    case 2:
      // Triplets MUST end in a semicolon.
      throw "Error: parameters ended while parsing the final element of a triplet! Did you forget a semicolon?";
      break;
    default:
      // Yeah, this will separate the array with commas. If you include commas in your parameters, you deserve useless debug output.
      flashpoint.log.debug(`Parsed mount parameters "${argsarr}"`);
      break;
  }
  return argsarr;
}

// Run the functions for all relevant mount params.
export async function runParams(params: string[], isBefore: boolean, currentlyMounted: Set<string>, isDocker: boolean): Promise<boolean> {
  return new Promise(async (resolve, reject) => {
    // Track the index of the current parameter.
    let index: number = 0;
    // The current keyword.
    var keyword: string;
    // The arguments to be passed to the current keyword's function.
    let args: string[];
    // While we aren't out of parameters...
    while (index < params.length) {
      // Set the current keyword and increment index.
      keyword = params[index++];
      // Check that keyword exists in keywordFunctions.
      if (!(keyword in keywordFunctions)) {
        reject(new Error(`Error: ${keyword} does not exist in keywordFunctions!`));
      }
      // Get the right number of arguments, and increment index by the number of args.
      args = params.slice(index, index += keywordFunctions[keyword].numArgs);
      // Check that there were enough arguments. If there weren't, the argument array will be too short.
      if (args.length != keywordFunctions[keyword].numArgs) {
        reject(new Error(`Error: not enough arguments for ${keyword}: ${args.length}.`));
      }
      // If the current keyword's before-ness matches the current state, run its function.
      if (isBefore == keywordFunctions[keyword].runBefore) {
        // If that function returns false, we should return false.
        if (!(await keywordFunctions[keyword].runFunc(args, currentlyMounted, isDocker))) {
          resolve(false);
        }
      }
    }
    // Everything worked. We should return true.
    resolve(true);
  });
}
